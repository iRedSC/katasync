import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { type Draft, reader, replierWith, translator } from "#/ai/agents";
import { OutOfTimeError, runAgent } from "#/ai/harness";
import type { Db } from "#/db/client";
import {
	buyerMarketplaceMessages,
	buyerMessages,
	buyerThreads,
	dispatchOrders,
	orderLines,
	orders,
	replyDrafts,
	shipments,
	stores,
} from "#/db/schema";
import { knownOf } from "#/orders/tracking-read";
import { draftFits } from "./chat-way";
import { orderSummary } from "./order";
import { basePrompt, listPrecedents } from "./precedents";
import { threadsPage } from "./threads";

// The suggested reply on each thread waiting on us, and buyers' words in
// English. The agent drafts once per buyer message: a newer message makes
// the draft out of date and it's drafted again, whoever last edited it.
// One run at a time drafts a thread: drafting is claimed in the database,
// and a draft finishing never overwrites one staff or Claude saved
// meanwhile. Server only.

// A claim on drafting this old is from a run that died; take it over.
const CLAIM_STALE_MS = 5 * 60_000;
// A failed draft is tried again this long after, unless the buyer writes.
const RETRY_FAILED_MS = 30 * 60_000;

type Run = typeof runAgent;

// Reads buyers' messages not yet read: their language, and English. A
// failure leaves the message for the next run.
export async function readNewMessages(db: Db, limit = 20, run: Run = runAgent) {
	const pending = await db
		.select({ id: buyerMessages.id, body: buyerMessages.body })
		.from(buyerMessages)
		.where(
			// A message of only pictures has nothing to read.
			and(
				eq(buyerMessages.fromBuyer, true),
				isNull(buyerMessages.language),
				sql`${buyerMessages.body} <> ''`,
			),
		)
		.orderBy(desc(buyerMessages.at))
		.limit(limit);
	const problems: string[] = [];
	await Promise.all(
		pending.map(async (m) => {
			try {
				const r = await run(reader, m.body);
				await db
					.update(buyerMessages)
					.set({
						language: r.language,
						english: r.language === "en" ? null : r.english,
					})
					.where(eq(buyerMessages.id, m.id));
			} catch (error) {
				problems.push(error instanceof Error ? error.message : String(error));
			}
		}),
	);
	return { read: pending.length - problems.length, problems };
}

// The buyer's language: that of their latest message read.
async function languageOf(db: Db, threadId: number) {
	const [row] = await db
		.select({ language: buyerMessages.language })
		.from(buyerMessages)
		.where(
			and(
				eq(buyerMessages.threadId, threadId),
				eq(buyerMessages.fromBuyer, true),
				sql`${buyerMessages.language} is not null`,
			),
		)
		.orderBy(desc(buyerMessages.at))
		.limit(1);
	return row?.language ?? "en";
}

// Takes the thread's draft for writing, as of the buyer's latest message;
// null when another run has it or it's already current.
async function claim(
	db: Db,
	threadId: number,
	forMessageId: number,
	orderRef: string | null,
	force: boolean,
) {
	const now = new Date();
	const [row] = await db
		.insert(replyDrafts)
		.values({
			threadId,
			state: "drafting",
			by: "ai",
			forMessageId,
			orderRef,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: replyDrafts.threadId,
			set: { state: "drafting", error: null, orderRef, updatedAt: now },
			setWhere: or(
				lt(replyDrafts.updatedAt, new Date(now.getTime() - CLAIM_STALE_MS)),
				and(
					sql`${replyDrafts.state} <> 'drafting'`,
					force
						? undefined
						: or(
								isNull(replyDrafts.forMessageId),
								lt(replyDrafts.forMessageId, forMessageId),
								// Written about another of the buyer's orders.
								sql`${replyDrafts.orderRef} is distinct from ${orderRef}`,
								and(
									eq(replyDrafts.state, "failed"),
									lt(
										replyDrafts.updatedAt,
										new Date(now.getTime() - RETRY_FAILED_MS),
									),
								),
							),
				),
			),
		})
		.returning();
	return row ?? null;
}

// Everything the agent goes on: the order (the thread's, or the one it was
// opened from), the conversation, the precedents.
async function brief(db: Db, threadId: number, about: string | null) {
	const [found] = await db
		.select()
		.from(buyerThreads)
		.where(eq(buyerThreads.id, threadId));
	if (!found) throw new Error(`There's no buyer thread ${threadId}`);
	const thread = { ...found, orderRef: about ?? found.orderRef };
	const [order] = thread.orderRef
		? await db
				.select({
					id: orders.id,
					placedAt: orders.placedAt,
					status: orders.fulfillmentStatus,
					cancelledAt: orders.cancelledAt,
					city: orders.shipCity,
					region: orders.shipRegion,
				})
				.from(orders)
				.innerJoin(stores, eq(stores.id, orders.storeId))
				.where(
					and(
						eq(stores.channel, thread.market),
						eq(orders.externalId, thread.orderRef),
					),
				)
				.limit(1)
		: [];
	const [lines, sent, messages, precedents, language, theirs] =
		await Promise.all([
			order
				? db
						.select({ title: orderLines.title, quantity: orderLines.quantity })
						.from(orderLines)
						.where(eq(orderLines.orderId, order.id))
				: [],
			order
				? db
						.select({
							carrier: shipments.carrier,
							service: shipments.serviceName,
							tracking: shipments.trackingNumber,
							shippedAt: shipments.createdAt,
						})
						.from(shipments)
						.innerJoin(
							dispatchOrders,
							eq(dispatchOrders.dispatchId, shipments.dispatchId),
						)
						.where(
							and(
								eq(dispatchOrders.orderId, order.id),
								isNull(shipments.voidedAt),
							),
						)
				: [],
			db
				.select({
					fromBuyer: buyerMessages.fromBuyer,
					body: buyerMessages.body,
					at: buyerMessages.at,
					status: buyerMessages.status,
				})
				.from(buyerMessages)
				.where(eq(buyerMessages.threadId, threadId))
				.orderBy(buyerMessages.at),
			listPrecedents(db),
			languageOf(db, threadId),
			db
				.select({
					kind: buyerMarketplaceMessages.kind,
					body: buyerMarketplaceMessages.body,
					at: buyerMarketplaceMessages.at,
				})
				.from(buyerMarketplaceMessages)
				.where(eq(buyerMarketplaceMessages.threadId, threadId)),
		]);
	return JSON.stringify(
		{
			marketplace: thread.market,
			buyer: thread.buyerName,
			subject: thread.subject,
			buyer_language: language,
			order: order
				? {
						number: thread.orderRef,
						placed: order.placedAt,
						status: order.cancelledAt ? "cancelled" : order.status,
						ships_to: [order.city, order.region].filter(Boolean).join(", "),
						items: lines,
						// Where each package is now, by the carrier.
						packages:
							(await orderSummary(db, order.id)).packages.map((p) => {
								const t = knownOf(p.tracking);
								return {
									carrier: p.carrier,
									tracking: p.number,
									shipped: p.shippedAt,
									status: t?.status ?? null,
									detail: t?.statusDetail ?? null,
									arrives: t?.eta ?? null,
									delivered: t?.status === "DELIVERED" ? t.statusAt : null,
									// Scans from before a failed refresh are only as of then.
									as_of: t?.checkedAt ?? null,
									...(p.tracking.state === "stale" ||
									p.tracking.state === "failed"
										? { tracking_unavailable: p.tracking.why }
										: {}),
								};
							}) ?? sent,
					}
				: thread.orderRef
					? { number: thread.orderRef, note: "not in our records yet" }
					: null,
			// With what the marketplace's assistant already told the buyer.
			conversation: [
				...messages
					.filter((m) => m.fromBuyer || m.status !== "failed")
					.map((m) => ({
						from: m.fromBuyer ? "buyer" : "us",
						at: m.at,
						text: m.body,
					})),
				...theirs
					.filter((m) => m.body)
					.map((m) => ({
						from: `${thread.market} ${m.kind === "assistant" ? "assistant (automatic, not us)" : "notice"}`,
						at: m.at,
						text: m.body,
					})),
			].sort((a, b) => a.at.getTime() - b.at.getTime()),
			precedents: precedents.map((p) => ({
				id: p.id,
				name: p.name,
				when: p.when,
				do: p.action,
			})),
		},
		null,
		1,
	);
}

// The order a draft is about, as kept: null when it's the thread's own.
async function aboutOrder(db: Db, threadId: number, orderRef: string | null) {
	if (orderRef === null) return null;
	const [t] = await db
		.select({ orderRef: buyerThreads.orderRef })
		.from(buyerThreads)
		.where(eq(buyerThreads.id, threadId));
	return t?.orderRef === orderRef ? null : orderRef;
}

// Drafts one thread's reply now, unless another run is drafting it or it's
// current (force drafts it again anyway). orderRef: about another of the
// buyer's orders than the thread's (the one its chat was opened from).
// What it wrote, or null.
export async function draftThread(
	db: Db,
	threadId: number,
	{
		force = false,
		run = runAgent,
		orderRef: asked = null,
	}: { force?: boolean; run?: Run; orderRef?: string | null } = {},
) {
	const orderRef = await aboutOrder(db, threadId, asked);
	const [latest] = await db
		.select({ id: buyerMessages.id })
		.from(buyerMessages)
		.where(
			and(
				eq(buyerMessages.threadId, threadId),
				eq(buyerMessages.fromBuyer, true),
			),
		)
		.orderBy(desc(buyerMessages.at), desc(buyerMessages.id))
		.limit(1);
	if (!latest) return null;
	const claimed = await claim(db, threadId, latest.id, orderRef, force);
	if (!claimed) return null;
	const mine = and(
		eq(replyDrafts.threadId, threadId),
		eq(replyDrafts.state, "drafting"),
		eq(replyDrafts.updatedAt, claimed.updatedAt),
	);
	let draft: Draft;
	try {
		const base = await basePrompt(db);
		draft = await run(
			replierWith(base.prompt),
			await brief(db, threadId, orderRef),
		);
	} catch (error) {
		// Out of time is no failure: the claim is left as if long gone, so
		// the next run takes it over.
		if (error instanceof OutOfTimeError) {
			await db
				.update(replyDrafts)
				.set({ updatedAt: new Date(0) })
				.where(mine);
			return null;
		}
		await db
			.update(replyDrafts)
			.set({
				state: "failed",
				error: error instanceof Error ? error.message : String(error),
				updatedAt: new Date(),
			})
			.where(mine);
		return null;
	}
	const known = new Set((await listPrecedents(db)).map((p) => p.id));
	const [saved] = await db
		.update(replyDrafts)
		.set({
			state: "ready",
			body: draft.reply.trim(),
			english: draft.english?.trim() || null,
			note: draft.note?.trim() || null,
			precedentIds: draft.precedents.filter((id) => known.has(id)),
			forMessageId: latest.id,
			orderRef,
			by: "ai",
			error: null,
			updatedAt: new Date(),
		})
		// Only the claim it made: an edit saved meanwhile stays.
		.where(mine)
		.returning();
	return saved ?? null;
}

// Drafts the threads waiting on us that need one, a few a run.
export async function draftWaiting(db: Db, limit = 4, run: Run = runAgent) {
	const waiting = (await threadsPage(db, "open", null))
		.filter((t) => t.waiting && t.market !== "shopify")
		.sort(
			(a, b) =>
				(a.waiting?.due.getTime() ?? 0) - (b.waiting?.due.getTime() ?? 0),
		);
	// Those already current cost a query, not a draft; the rest go at once,
	// so a slow model holds the run up once, not once a thread.
	const due = [];
	for (const t of waiting) {
		if (due.length >= limit) break;
		const d = t.draft;
		const latest = t.messages.filter((m) => m.fromBuyer).at(-1);
		// Current, or being drafted by a run still alive: nothing to do. A
		// failed one is left to the claim, which waits before trying again.
		const age = Date.now() - new Date(d?.updatedAt ?? 0).getTime();
		if (
			d &&
			latest &&
			!d.stale &&
			// About the thread's own order, not one its chat was opened from.
			draftFits(d, t.orderRef) &&
			(d.state === "ready" ||
				(d.state === "drafting" && age < CLAIM_STALE_MS) ||
				(d.state === "failed" && age < RETRY_FAILED_MS))
		)
			continue;
		due.push(t);
	}
	const results = await Promise.all(
		due.map((t) => draftThread(db, t.id, { run })),
	);
	const drafted = results.filter(Boolean).length;
	return drafted;
}

// Saves a suggested reply as written by staff or Claude, current as of the
// buyer's latest message.
export async function setDraft(
	db: Db,
	threadId: number,
	draft: { body: string; english?: string | null },
	by: "staff" | "claude",
	// About another of the buyer's orders than the thread's.
	asked: string | null = null,
) {
	const body = draft.body.trim();
	const orderRef = await aboutOrder(db, threadId, asked);
	if (!body) throw new Error("A suggested reply needs words");
	const [latest] = await db
		.select({ id: buyerMessages.id })
		.from(buyerMessages)
		.where(
			and(
				eq(buyerMessages.threadId, threadId),
				eq(buyerMessages.fromBuyer, true),
			),
		)
		.orderBy(desc(buyerMessages.at), desc(buyerMessages.id))
		.limit(1);
	const values = {
		state: "ready" as const,
		body,
		english: draft.english?.trim() || null,
		note: null,
		by,
		error: null,
		forMessageId: latest?.id ?? null,
		orderRef,
		updatedAt: new Date(),
	};
	const [row] = await db
		.insert(replyDrafts)
		.values({ threadId, ...values })
		.onConflictDoUpdate({ target: replyDrafts.threadId, set: values })
		.returning();
	return row;
}

// The suggestion is used up once a reply goes.
export async function clearDraft(db: Db, threadId: number) {
	await db.delete(replyDrafts).where(eq(replyDrafts.threadId, threadId));
}

// Staff's English, in the buyer's language; as is when that's English.
export async function translateForBuyer(
	db: Db,
	threadId: number,
	text: string,
	run: Run = runAgent,
) {
	const language = await languageOf(db, threadId);
	if (language === "en") return { language, text };
	const r = await run(
		translator,
		JSON.stringify({ to: language, reply: text }),
	);
	return { language, text: r.text };
}

// Drafts for threads, for the page.
export async function draftsFor(db: Db, threadIds: number[]) {
	if (threadIds.length === 0) return [];
	return db
		.select()
		.from(replyDrafts)
		.where(inArray(replyDrafts.threadId, threadIds));
}
