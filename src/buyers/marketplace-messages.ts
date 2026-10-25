import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { reader } from "#/ai/agents";
import { runAgent } from "#/ai/harness";
import type { Db } from "#/db/client";
import {
	buyerMarketplaceMessages,
	buyerThreads,
	orderLines,
	orders,
	products,
	stores,
} from "#/db/schema";

// What a marketplace itself put in a buyer's conversation (TikTok's
// assistant, notices, order and shipping cards): kept once each, read into
// English like the buyer's words, and shown with the thread. Never a
// buyer's message or our answer, so it never changes whether a thread
// waits on us. Server only.

export type MarketplaceMessageKind =
	(typeof buyerMarketplaceMessages.$inferSelect)["kind"];

export type ListedMarketplaceMessage = {
	externalId: string;
	at: Date;
} & (
	| { kind: "assistant" | "notice"; body: string }
	| { kind: "order_card"; orderRef: string }
	| { kind: "shipping_card"; orderRef: string; packageRef: string | null }
	| { kind: "other" }
);

export async function keepMarketplaceMessages(
	db: Db,
	threadId: number,
	listed: ListedMarketplaceMessage[],
) {
	if (listed.length === 0) return;
	await db
		.insert(buyerMarketplaceMessages)
		.values(
			listed.map((m) => ({
				threadId,
				externalId: m.externalId,
				kind: m.kind,
				at: m.at,
				body: "body" in m ? m.body : "",
				orderRef: "orderRef" in m ? m.orderRef : null,
				packageRef: "packageRef" in m ? m.packageRef : null,
			})),
		)
		.onConflictDoNothing();
}

// Each thread's, oldest first; a card with the order it names, when it's in
// katasync: its first product, how many items, and the total.
export async function marketplaceMessagesOf(db: Db, threadIds: number[]) {
	if (threadIds.length === 0) return [];
	const rows = await db
		.select({
			id: buyerMarketplaceMessages.id,
			threadId: buyerMarketplaceMessages.threadId,
			kind: buyerMarketplaceMessages.kind,
			body: buyerMarketplaceMessages.body,
			english: buyerMarketplaceMessages.english,
			orderRef: buyerMarketplaceMessages.orderRef,
			at: buyerMarketplaceMessages.at,
			market: buyerThreads.market,
		})
		.from(buyerMarketplaceMessages)
		.innerJoin(
			buyerThreads,
			eq(buyerThreads.id, buyerMarketplaceMessages.threadId),
		)
		.where(inArray(buyerMarketplaceMessages.threadId, threadIds))
		.orderBy(
			asc(buyerMarketplaceMessages.at),
			asc(buyerMarketplaceMessages.id),
		);
	const refs = [
		...new Set(rows.flatMap((r) => (r.orderRef ? [r.orderRef] : []))),
	];
	const found =
		refs.length === 0
			? []
			: await db
					.select({
						id: orders.id,
						name: orders.name,
						total: orders.total,
						channel: stores.channel,
						externalId: orders.externalId,
						title: orderLines.title,
						quantity: orderLines.quantity,
						imageUrl: products.imageUrl,
					})
					.from(orders)
					.innerJoin(stores, eq(stores.id, orders.storeId))
					.leftJoin(orderLines, eq(orderLines.orderId, orders.id))
					.leftJoin(products, eq(products.id, orderLines.productId))
					.where(inArray(orders.externalId, refs))
					.orderBy(asc(orderLines.id));
	const orderOf = (market: string, ref: string) => {
		const lines = found.filter(
			(o) => o.channel === market && o.externalId === ref,
		);
		const first = lines[0];
		return first
			? {
					id: first.id,
					name: first.name,
					total: first.total,
					title: first.title,
					imageUrl: first.imageUrl,
					items: lines.reduce((n, l) => n + (l.quantity ?? 0), 0),
				}
			: null;
	};
	return rows.map(({ market, ...r }) => ({
		...r,
		order: r.orderRef ? orderOf(market, r.orderRef) : null,
	}));
}

export type MarketplaceMessage = Awaited<
	ReturnType<typeof marketplaceMessagesOf>
>[number];

// Reads the marketplace's words not yet read: their language, and English.
// A failure leaves the message for the next run.
export async function readMarketplaceMessages(
	db: Db,
	limit = 20,
	run: typeof runAgent = runAgent,
) {
	const pending = await db
		.select({
			id: buyerMarketplaceMessages.id,
			body: buyerMarketplaceMessages.body,
		})
		.from(buyerMarketplaceMessages)
		.where(
			and(
				isNull(buyerMarketplaceMessages.language),
				sql`${buyerMarketplaceMessages.body} <> ''`,
			),
		)
		.orderBy(desc(buyerMarketplaceMessages.at))
		.limit(limit);
	const problems: string[] = [];
	await Promise.all(
		pending.map(async (m) => {
			try {
				const r = await run(reader, m.body);
				await db
					.update(buyerMarketplaceMessages)
					.set({
						language: r.language,
						english: r.language === "en" ? null : r.english,
					})
					.where(eq(buyerMarketplaceMessages.id, m.id));
			} catch (error) {
				problems.push(error instanceof Error ? error.message : String(error));
			}
		}),
	);
	return { read: pending.length - problems.length, problems };
}
