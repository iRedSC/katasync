import {
	and,
	desc,
	eq,
	gte,
	isNotNull,
	isNull,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Filing, filer } from "#/ai/agents";
import { type Agent, OutOfTimeError, runAgent } from "#/ai/harness";
import type { Db } from "#/db/client";
import {
	poEmailAi,
	poEmailAttachments,
	poEmails,
	purchaseOrderTracking,
} from "#/db/schema";
import { orderForClaude } from "#/mcp/server/po-for-claude";
import { flagsOfEmails, lineFor, raiseFlag } from "#/purchasing/flags";
import { PurchaseOrderError } from "#/purchasing/orders";
import {
	CONCURRENCY,
	checkTracking,
	eachLimit,
	putTracking,
} from "#/purchasing/tracking";
import {
	ClaimLostError,
	claim,
	type Holder,
	held,
	lockHeld,
	settle,
	takeable,
} from "./ai-filing-claims";
import type { Applied, FlagInput, Proposal } from "./ai-filing-shapes";
import {
	EmailMovedError,
	emailWithFiles,
	fileEmail,
	moveEmail,
} from "./ingest";
import { findTracking } from "./tracking-numbers";
import { likelihood, mentionedPos, recentPos } from "./views";

// The AI's go at emails that nothing filed by itself (src/purchasing/inbox
// /ingest.ts): the filer agent says which earlier email each is a copy of,
// which it sets aside, or else which PO it's about, its tracking, and flags
// what it says should change there. When it's sure, this files the
// email, follows the tracking, and raises the flags (src/purchasing/flags.ts),
// which staff apply or dismiss: nothing here changes a PO's lines. When it
// isn't sure, the PO waits as a suggestion staff take with one click. Undo
// takes the email off, its tracking and open flags with it. Server only.

// Older emails waiting to be filed are left to staff: by now someone has
// read them, and the PO has likely moved on.
const LOOK_BACK_MS = 14 * 86_400_000;
// How much of an email the agent reads.
const BODY_CHARS = 12_000;
const FILE_CHARS = 8_000;
const FILES = 6;
// POs read in full up front, and listed by name for read_po.
const LIKELY_POS = 3;
const OTHER_POS = 40;
// Earlier emails it may be a copy of: the sender's lately, and any with the
// same file.
const EARLIER_EMAILS = 8;
const EARLIER_BODY_CHARS = 1_500;

type Run = typeof runAgent;
export type Outcome = "filed" | "suggested" | "unmatched" | "set_aside";

async function waiting(db: Db, limit: number, now: Date) {
	const rows = await db
		.select({ id: poEmails.id })
		.from(poEmails)
		.leftJoin(poEmailAi, eq(poEmailAi.emailId, poEmails.id))
		.where(
			and(
				isNull(poEmails.purchaseOrderId),
				isNull(poEmails.setAsideAt),
				gte(poEmails.receivedAt, new Date(now.getTime() - LOOK_BACK_MS)),
				or(isNull(poEmailAi.emailId), takeable(now)),
			),
		)
		.orderBy(desc(poEmails.receivedAt))
		.limit(limit);
	return rows.map((r) => r.id);
}

// Emails before this one it may be a copy of: from the same sender in the
// last LOOK_BACK_MS, or carrying a file with the same bytes (name and size,
// for a file too big to keep). Pictures inside the body, logos, don't count.
async function earlierEmails(
	db: Db,
	email: { id: number; fromAddress: string; receivedAt: Date },
) {
	const mine = alias(poEmailAttachments, "mine");
	const same = await db
		.selectDistinct({
			emailId: poEmailAttachments.emailId,
			filename: poEmailAttachments.filename,
		})
		.from(poEmailAttachments)
		.innerJoin(
			mine,
			and(
				eq(mine.emailId, email.id),
				isNull(mine.contentId),
				eq(mine.size, poEmailAttachments.size),
				sql`case when ${mine.data} is null or ${poEmailAttachments.data} is null
					then ${mine.filename} = ${poEmailAttachments.filename}
					else md5(${mine.data}) = md5(${poEmailAttachments.data}) end`,
			),
		)
		.where(
			and(
				ne(poEmailAttachments.emailId, email.id),
				isNull(poEmailAttachments.contentId),
			),
		);
	const sameFiles = new Map<number, string[]>();
	for (const f of same)
		sameFiles.set(f.emailId, [...(sameFiles.get(f.emailId) ?? []), f.filename]);
	const before = or(
		lt(poEmails.receivedAt, email.receivedAt),
		and(eq(poEmails.receivedAt, email.receivedAt), lt(poEmails.id, email.id)),
	);
	const rows = await db
		.select({
			id: poEmails.id,
			from: poEmails.fromAddress,
			subject: poEmails.subject,
			receivedAt: poEmails.receivedAt,
			purchaseOrderId: poEmails.purchaseOrderId,
			setAsideAt: poEmails.setAsideAt,
			body: poEmails.body,
		})
		.from(poEmails)
		.where(
			and(
				before,
				or(
					and(
						sql`lower(${poEmails.fromAddress}) = ${email.fromAddress.toLowerCase()}`,
						gte(
							poEmails.receivedAt,
							new Date(email.receivedAt.getTime() - LOOK_BACK_MS),
						),
					),
					sameFiles.size > 0
						? sql`${poEmails.id} in (${sql.join(
								[...sameFiles.keys()].map((id) => sql`${id}`),
								sql`, `,
							)})`
						: undefined,
				),
			),
		)
		.orderBy(desc(poEmails.receivedAt))
		.limit(EARLIER_EMAILS);
	return rows.map((e) => ({
		id: e.id,
		from: e.from,
		subject: e.subject,
		receivedAt: e.receivedAt,
		on:
			e.purchaseOrderId !== null
				? `PO ${e.purchaseOrderId}`
				: e.setAsideAt
					? "set aside"
					: "unfiled",
		sameFiles: sameFiles.get(e.id) ?? [],
		body: e.body.slice(0, EARLIER_BODY_CHARS),
	}));
}

// What the agent reads: the email and its files, the earlier emails it may
// be a copy of, the POs it's likeliest about in full, and the rest of the
// recent ones by name.
async function brief(db: Db, emailId: number) {
	const [{ email, files }, pos] = await Promise.all([
		emailWithFiles(db, emailId),
		recentPos(db),
	]);
	const earlier = await earlierEmails(db, email);
	const mentions = mentionedPos(`${email.subject}\n${email.body}`);
	const rank = (p: (typeof pos)[number]) => {
		const l = likelihood(email, p, mentions);
		return l === "mentions" ? 0 : l === "supplier" ? 1 : 2;
	};
	const ranked = [...pos].sort((a, b) => rank(a) - rank(b));
	const likely = ranked.filter((p) => rank(p) < 2).slice(0, LIKELY_POS);
	const others = ranked.filter((p) => !likely.includes(p)).slice(0, OTHER_POS);
	const input = JSON.stringify({
		email: {
			from: email.fromName
				? `${email.fromName} <${email.fromAddress}>`
				: email.fromAddress,
			subject: email.subject,
			receivedAt: email.receivedAt,
			body: email.body.slice(0, BODY_CHARS),
			files: files.slice(0, FILES).map((f) => ({
				name: f.filename,
				text: f.text?.slice(0, FILE_CHARS) ?? null,
			})),
		},
		earlierEmails: earlier,
		likelyPos: await Promise.all(likely.map((p) => orderForClaude(db, p.id))),
		otherPos: others.map((p) => ({
			po: p.id,
			supplier: p.supplier,
			sentAt: p.sentAt,
		})),
	});
	return {
		input,
		candidates: new Set(pos.map((p) => p.id)),
		earlier: new Set(earlier.map((e) => e.id)),
	};
}

const FLAG_PARAMETERS = {
	type: "object",
	properties: {
		po: { type: "integer" },
		kind: { type: "string", enum: ["price", "quantity", "back_order", "note"] },
		sku: {
			type: ["string", "null"],
			description:
				"From the PO's lines; null only for a note about the whole PO",
		},
		value: {
			type: ["number", "null"],
			description:
				"price: per the line's unit. quantity: how many of the line's unit. Null otherwise.",
		},
		note: { type: "string", description: "Why, in a few words" },
	},
	required: ["po", "kind", "note"],
};

// The flag tool's input, checked: what it says and the PO it's on.
async function flagFrom(
	db: Db,
	candidates: Set<number>,
	input: Record<string, unknown>,
): Promise<{ po: number; flag: FlagInput }> {
	const po = Number(input.po);
	if (!candidates.has(po))
		throw new Error(`PO ${po} isn't one an email can go on`);
	const note = String(input.note ?? "").trim();
	if (!note) throw new Error("Say why in the note");
	const sku = typeof input.sku === "string" && input.sku ? input.sku : null;
	const kind = input.kind;
	if (kind === "note") return { po, flag: { kind, sku, note } };
	if (kind !== "price" && kind !== "quantity" && kind !== "back_order")
		throw new Error(`There's no kind ${String(kind)}`);
	if (!sku) throw new Error(`A ${kind} flag needs the line's sku`);
	const line = await lineFor(db, po, sku);
	if (kind === "back_order") return { po, flag: { kind, sku: line.sku, note } };
	const value = Number(input.value);
	if (!(value >= 0) || (kind === "quantity" && !Number.isInteger(value)))
		throw new Error(`A ${kind} can't be ${String(input.value)}`);
	return { po, flag: { kind, sku: line.sku, value, note } };
}

// The filer, able to read any PO it may file on, and flag what the email
// says should change there; the flags are kept, per PO, in flagged.
function filerFor(
	db: Db,
	candidates: Set<number>,
	flagged: { po: number; flag: FlagInput }[],
): Agent<Filing> {
	return {
		...filer,
		tools: [
			{
				name: "read_po",
				description:
					"Reads a PO from the lists: its supplier, lines, and status.",
				parameters: {
					type: "object",
					properties: { po: { type: "integer" } },
					required: ["po"],
				},
				run: async (input) => {
					const po = Number(input.po);
					if (!candidates.has(po))
						throw new Error(`PO ${po} isn't one an email can go on`);
					return orderForClaude(db, po);
				},
			},
			{
				name: "flag",
				description:
					"Flags something the email says should change on a PO, for staff to apply or dismiss. Changes nothing itself.",
				parameters: FLAG_PARAMETERS,
				run: async (input) => {
					flagged.push(await flagFrom(db, candidates, input));
					return "Flagged";
				},
			},
		],
	};
}

// Files the email on the PO, follows its tracking, and raises its flags. A
// number or flag the PO won't take (a cancelled PO, a line taken off) is
// kept as skipped, with why. Filing, tracking, flags, and the AI's record
// commit together, under the email's lock, so none lands on a PO the email
// isn't on and a crash leaves nothing half done; only asking Shippo waits
// until after. Throws EmailMovedError, doing nothing, when the email was
// filed or set aside meanwhile, and ClaimLostError when another run took it.
async function apply(
	db: Db,
	input: {
		emailId: number;
		purchaseOrderId: number;
		proposal: Proposal;
		holder: Holder;
		// Why, from the run that was sure; staff keep the suggestion's.
		reason?: string;
	},
) {
	const { emailId, purchaseOrderId: po, proposal } = input;
	const { added, applied } = await db.transaction(async (tx) => {
		await lockHeld(tx, emailId, input.holder);
		const email = await moveEmail(tx, {
			emailId,
			purchaseOrderId: po,
			by: input.holder.by,
			onlyFrom: null,
		});
		const applied: Applied = { tracking: [], skipped: [] };
		// Only what the PO refuses is skipped: anything else (a deadlock, a
		// lost connection) fails the filing, so a later run tries it again.
		const skip = (what: string, error: unknown) => {
			if (!(error instanceof PurchaseOrderError)) throw error;
			applied.skipped.push({ what, why: error.message });
		};
		// Each in its own savepoint, so one the PO won't take undoes only
		// itself.
		const added: Parameters<typeof checkTracking>[1][] = [];
		const put = async (t: Proposal["tracking"][number]) => {
			const p = await tx.transaction((sp) =>
				putTracking(sp, { purchaseOrderId: po, ...t, emailId }),
			);
			if (p.added) added.push(p.row);
		};
		for (const t of proposal.tracking) {
			try {
				await put(t);
			} catch (error) {
				skip(t.number, error);
			}
		}
		// What the email says itself, as filing it by hand follows.
		for (const t of findTracking(`${email.subject}\n${email.body}`)) {
			try {
				await put(t);
			} catch (error) {
				if (!(error instanceof PurchaseOrderError)) throw error;
			}
		}
		for (const flag of proposal.flags) {
			try {
				await tx.transaction((sp) =>
					raiseFlag(sp, { purchaseOrderId: po, emailId, by: "ai", flag }),
				);
			} catch (error) {
				skip(flag.note, error);
			}
		}
		applied.tracking = (
			await tx
				.select({ number: purchaseOrderTracking.number })
				.from(purchaseOrderTracking)
				.where(
					and(
						eq(purchaseOrderTracking.emailId, emailId),
						eq(purchaseOrderTracking.purchaseOrderId, po),
					),
				)
		).map((t) => t.number);
		await tx
			.update(poEmailAi)
			.set({
				state: "filed",
				purchaseOrderId: po,
				proposal,
				applied,
				error: null,
				...(input.reason !== undefined && { reason: input.reason }),
				updatedAt: new Date(),
			})
			.where(eq(poEmailAi.emailId, emailId));
		return { added, applied };
	});
	// A package taken off since (staff moved the email) stays off: Shippo's
	// answer updates only its own row.
	await eachLimit(added, CONCURRENCY, (row) => checkTracking(db, row));
	return applied;
}

// Sets the email aside as a copy of an earlier one, and settles the claim,
// together. Throws EmailMovedError, doing nothing, when someone filed it
// meanwhile, and ClaimLostError when another run took it.
async function setAsideCopy(
	db: Db,
	input: {
		emailId: number;
		claim: string;
		duplicateOf: number;
		reason: string;
	},
) {
	await db.transaction(async (tx) => {
		await lockHeld(tx, input.emailId, { by: "ai", claim: input.claim });
		const [moved] = await tx
			.update(poEmails)
			.set({ setAsideAt: new Date() })
			.where(
				and(
					eq(poEmails.id, input.emailId),
					isNull(poEmails.purchaseOrderId),
					isNull(poEmails.setAsideAt),
				),
			)
			.returning({ id: poEmails.id });
		if (!moved)
			throw new EmailMovedError("Filed or set aside by someone meanwhile");
		await settle(tx, input.emailId, input.claim, {
			state: "set_aside",
			duplicateOf: input.duplicateOf,
			reason: input.reason,
		});
	});
}

async function fileOne(
	db: Db,
	emailId: number,
	token: string,
	run: Run,
): Promise<Outcome> {
	const { input, candidates, earlier } = await brief(db, emailId);
	const flagged: { po: number; flag: FlagInput }[] = [];
	const answer = await run(filerFor(db, candidates, flagged), input);
	if (answer.duplicateOf != null && earlier.has(answer.duplicateOf)) {
		try {
			await setAsideCopy(db, {
				emailId,
				claim: token,
				duplicateOf: answer.duplicateOf,
				reason: answer.reason,
			});
		} catch (error) {
			if (!(error instanceof EmailMovedError)) throw error;
			await settle(db, emailId, token, {
				state: "unmatched",
				reason: error.message,
			});
			return "unmatched";
		}
		return "set_aside";
	}
	const proposal: Proposal = {
		tracking: answer.tracking,
		flags: flagged.filter((f) => f.po === answer.po).map((f) => f.flag),
	};
	if (answer.po === null || !candidates.has(answer.po)) {
		await settle(db, emailId, token, {
			state: "unmatched",
			reason:
				answer.po === null
					? answer.reason
					: `${answer.reason} (PO ${answer.po} isn't a sent PO)`,
		});
		return "unmatched";
	}
	if (!answer.sure) {
		await settle(db, emailId, token, {
			state: "suggested",
			purchaseOrderId: answer.po,
			reason: answer.reason,
			proposal,
		});
		return "suggested";
	}
	try {
		await apply(db, {
			emailId,
			purchaseOrderId: answer.po,
			proposal,
			holder: { by: "ai", claim: token },
			reason: answer.reason,
		});
	} catch (error) {
		if (!(error instanceof EmailMovedError)) throw error;
		await settle(db, emailId, token, {
			state: "unmatched",
			reason: error.message,
		});
		return "unmatched";
	}
	return "filed";
}

// Files up to limit emails waiting to be filed, newest first, at once. A
// failure leaves the email for a later run; running out of time leaves it
// for the next. A run whose claim another took over leaves it to that one.
export async function fileWithAi(
	db: Db,
	{ limit = 3, run = runAgent }: { limit?: number; run?: Run } = {},
) {
	const now = new Date();
	const ids = await waiting(db, limit, now);
	const done = {
		filed: 0,
		suggested: 0,
		unmatched: 0,
		set_aside: 0,
		problems: [] as string[],
	};
	await Promise.all(
		ids.map(async (id) => {
			const token = await claim(db, id, now);
			if (!token) return;
			try {
				done[await fileOne(db, id, token, run)]++;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				done.problems.push(`Email ${id}: ${message}`);
				if (error instanceof ClaimLostError) return;
				const mine = and(eq(poEmailAi.emailId, id), held(token));
				if (error instanceof OutOfTimeError)
					await db.delete(poEmailAi).where(mine);
				else
					await db
						.update(poEmailAi)
						.set({
							state: "failed",
							error: message.slice(0, 2000),
							updatedAt: new Date(),
						})
						.where(mine);
			}
		}),
	);
	return done;
}

// Files a suggested email on the PO the AI suggested, with the changes it
// read from it, as if it had been sure. Staff's decision, so filed by staff.
// Taking it twice at once files it once: the second finds it filed.
export async function takeSuggestion(db: Db, emailId: number) {
	const [row] = await db
		.select()
		.from(poEmailAi)
		.where(
			and(eq(poEmailAi.emailId, emailId), eq(poEmailAi.state, "suggested")),
		);
	if (!row?.purchaseOrderId || !row.proposal)
		throw new PurchaseOrderError("There's no suggestion for that email now");
	const applied = await apply(db, {
		emailId,
		purchaseOrderId: row.purchaseOrderId,
		proposal: row.proposal,
		holder: { by: "staff" },
	});
	return { purchaseOrderId: row.purchaseOrderId, applied };
}

// Takes the email the AI filed back off its PO, to Unfiled: its tracking and
// the flags read from it that nobody acted on go with it. Flags someone
// applied or dismissed are theirs and stay, as does an email someone moved:
// each one kept is said, so an undo never looks complete when it isn't.
export async function undoFiling(db: Db, emailId: number) {
	const [row] = await db
		.update(poEmailAi)
		.set({ state: "undone", updatedAt: new Date() })
		.where(and(eq(poEmailAi.emailId, emailId), eq(poEmailAi.state, "filed")))
		.returning();
	if (!row || row.purchaseOrderId === null)
		throw new PurchaseOrderError("There's nothing filed by the AI to undo");
	const po = row.purchaseOrderId;
	const kept = (await flagsOfEmails(db, [emailId]))
		.filter((f) => f.purchaseOrderId === po && f.resolution !== null)
		.map((f) => `${f.sku ?? "a note"}, ${f.resolution}`);
	try {
		await fileEmail(db, {
			emailId,
			purchaseOrderId: null,
			by: "staff",
			onlyFrom: po,
		});
	} catch (error) {
		if (!(error instanceof EmailMovedError)) throw error;
		kept.push("the email, moved since");
	}
	return { purchaseOrderId: po, kept };
}

// Takes the email the AI set aside as a copy back to Unfiled, for good: the
// AI won't set it aside again. An email someone filed or brought back
// meanwhile stays where it is, and says so.
export async function undoSetAside(db: Db, emailId: number) {
	const [row] = await db
		.update(poEmailAi)
		.set({ state: "undone", updatedAt: new Date() })
		.where(
			and(eq(poEmailAi.emailId, emailId), eq(poEmailAi.state, "set_aside")),
		)
		.returning();
	if (!row)
		throw new PurchaseOrderError("There's nothing set aside by the AI to undo");
	const [back] = await db
		.update(poEmails)
		.set({ setAsideAt: null })
		.where(and(eq(poEmails.id, emailId), isNotNull(poEmails.setAsideAt)))
		.returning({ id: poEmails.id });
	return { kept: back ? [] : ["the email, moved since"] };
}
