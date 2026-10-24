import { and, desc, eq, gte, isNull, lt, or } from "drizzle-orm";
import { type Filing, filer } from "#/ai/agents";
import { type Agent, OutOfTimeError, runAgent } from "#/ai/harness";
import type { Db } from "#/db/client";
import { poEmailAi, poEmails, purchaseOrderTracking } from "#/db/schema";
import { orderForClaude } from "#/mcp/server/po-for-claude";
import { flagsOfEmails, lineFor, raiseFlag } from "#/purchasing/flags";
import { PurchaseOrderError } from "#/purchasing/orders";
import { addTracking } from "#/purchasing/tracking";
import type { Applied, FlagInput, Proposal } from "./ai-filing-shapes";
import { EmailMovedError, emailWithFiles, fileEmail } from "./ingest";
import { likelihood, mentionedPos, recentPos } from "./views";

// The AI's go at emails that nothing filed by itself (src/purchasing/inbox
// /ingest.ts): the filer agent says which PO each is about, its tracking,
// and flags what it says should change there. When it's sure, this files the
// email, follows the tracking, and raises the flags (src/purchasing/flags.ts),
// which staff apply or dismiss: nothing here changes a PO's lines. When it
// isn't sure, the PO waits as a suggestion staff take with one click. Undo
// takes the email off, its tracking and open flags with it. Server only.

// Older emails waiting to be filed are left to staff: by now someone has
// read them, and the PO has likely moved on.
const LOOK_BACK_MS = 14 * 86_400_000;
// A claim this old is from a run that died; take it over.
const CLAIM_STALE_MS = 5 * 60_000;
// A failed email is tried again this long after.
const RETRY_FAILED_MS = 30 * 60_000;
// How much of an email the agent reads.
const BODY_CHARS = 12_000;
const FILE_CHARS = 8_000;
const FILES = 6;
// POs read in full up front, and listed by name for read_po.
const LIKELY_POS = 3;
const OTHER_POS = 40;

type Run = typeof runAgent;
export type Outcome = "filed" | "suggested" | "unmatched";

// Which claims a run may take: none yet, a failure old enough to try again,
// or a dead run's.
function takeable(now: Date) {
	return or(
		and(
			eq(poEmailAi.state, "failed"),
			lt(poEmailAi.updatedAt, new Date(now.getTime() - RETRY_FAILED_MS)),
		),
		and(
			eq(poEmailAi.state, "working"),
			lt(poEmailAi.updatedAt, new Date(now.getTime() - CLAIM_STALE_MS)),
		),
	);
}

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

// Takes the email for this run; false when another run has it.
async function claim(db: Db, emailId: number, now: Date) {
	const [row] = await db
		.insert(poEmailAi)
		.values({ emailId, state: "working", updatedAt: now })
		.onConflictDoUpdate({
			target: poEmailAi.emailId,
			set: { state: "working", error: null, updatedAt: now },
			setWhere: takeable(now),
		})
		.returning({ emailId: poEmailAi.emailId });
	return row !== undefined;
}

// Ends this run's claim; a claim another run took over is left to it.
async function settle(
	db: Db,
	emailId: number,
	set: Partial<typeof poEmailAi.$inferInsert>,
) {
	await db
		.update(poEmailAi)
		.set({ ...set, updatedAt: new Date() })
		.where(and(eq(poEmailAi.emailId, emailId), eq(poEmailAi.state, "working")));
}

// What the agent reads: the email and its files, the POs it's likeliest
// about in full, and the rest of the recent ones by name.
async function brief(db: Db, emailId: number) {
	const [{ email, files }, pos] = await Promise.all([
		emailWithFiles(db, emailId),
		recentPos(db),
	]);
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
		likelyPos: await Promise.all(likely.map((p) => orderForClaude(db, p.id))),
		otherPos: others.map((p) => ({
			po: p.id,
			supplier: p.supplier,
			sentAt: p.sentAt,
		})),
	});
	return { input, candidates: new Set(pos.map((p) => p.id)) };
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
// kept as skipped, with why. Throws EmailMovedError, doing nothing, when the
// email was filed or set aside meanwhile.
async function apply(
	db: Db,
	input: {
		emailId: number;
		purchaseOrderId: number;
		proposal: Proposal;
		by: "ai" | "staff";
	},
) {
	const { emailId, purchaseOrderId: po, proposal } = input;
	await fileEmail(db, {
		emailId,
		purchaseOrderId: po,
		by: input.by,
		onlyFrom: null,
	});
	const applied: Applied = { tracking: [], skipped: [] };
	const skip = (what: string, error: unknown) =>
		applied.skipped.push({
			what,
			why: error instanceof Error ? error.message : String(error),
		});
	for (const t of proposal.tracking) {
		try {
			await addTracking(db, { purchaseOrderId: po, ...t, emailId });
		} catch (error) {
			skip(t.number, error);
		}
	}
	for (const flag of proposal.flags) {
		try {
			await raiseFlag(db, { purchaseOrderId: po, emailId, by: "ai", flag });
		} catch (error) {
			skip(flag.note, error);
		}
	}
	applied.tracking = (
		await db
			.select({ number: purchaseOrderTracking.number })
			.from(purchaseOrderTracking)
			.where(
				and(
					eq(purchaseOrderTracking.emailId, emailId),
					eq(purchaseOrderTracking.purchaseOrderId, po),
				),
			)
	).map((t) => t.number);
	await db
		.update(poEmailAi)
		.set({
			state: "filed",
			purchaseOrderId: po,
			proposal,
			applied,
			error: null,
			updatedAt: new Date(),
		})
		.where(eq(poEmailAi.emailId, emailId));
	return applied;
}

async function fileOne(db: Db, emailId: number, run: Run): Promise<Outcome> {
	const { input, candidates } = await brief(db, emailId);
	const flagged: { po: number; flag: FlagInput }[] = [];
	const answer = await run(filerFor(db, candidates, flagged), input);
	const proposal: Proposal = {
		tracking: answer.tracking,
		flags: flagged.filter((f) => f.po === answer.po).map((f) => f.flag),
	};
	if (answer.po === null || !candidates.has(answer.po)) {
		await settle(db, emailId, {
			state: "unmatched",
			reason:
				answer.po === null
					? answer.reason
					: `${answer.reason} (PO ${answer.po} isn't a sent PO)`,
		});
		return "unmatched";
	}
	if (!answer.sure) {
		await settle(db, emailId, {
			state: "suggested",
			purchaseOrderId: answer.po,
			reason: answer.reason,
			proposal,
		});
		return "suggested";
	}
	await db
		.update(poEmailAi)
		.set({ reason: answer.reason })
		.where(eq(poEmailAi.emailId, emailId));
	try {
		await apply(db, {
			emailId,
			purchaseOrderId: answer.po,
			proposal,
			by: "ai",
		});
	} catch (error) {
		if (!(error instanceof EmailMovedError)) throw error;
		await settle(db, emailId, { state: "unmatched", reason: error.message });
		return "unmatched";
	}
	return "filed";
}

// Files up to limit emails waiting to be filed, newest first, at once. A
// failure leaves the email for a later run; running out of time leaves it
// for the next.
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
		problems: [] as string[],
	};
	await Promise.all(
		ids.map(async (id) => {
			if (!(await claim(db, id, now))) return;
			try {
				done[await fileOne(db, id, run)]++;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				done.problems.push(`Email ${id}: ${message}`);
				if (error instanceof OutOfTimeError)
					await db
						.delete(poEmailAi)
						.where(
							and(eq(poEmailAi.emailId, id), eq(poEmailAi.state, "working")),
						);
				else
					await settle(db, id, {
						state: "failed",
						error: message.slice(0, 2000),
					});
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
		by: "staff",
	});
	return { purchaseOrderId: row.purchaseOrderId, applied };
}

// Takes the email the AI filed back off its PO, to To file: its tracking and
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
