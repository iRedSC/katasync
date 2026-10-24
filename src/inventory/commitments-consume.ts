import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	stockCommitmentEntries,
	stockCommitments,
	unreservedShipments,
} from "#/db/quantity-schema";
import { orderLines, orders } from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { lockStockProducts } from "#/inventory/ledger/post";
import {
	type LineHistory,
	lineHistories,
	readQuantityMode,
} from "./commitments";
import {
	allocate,
	ConsumeError,
	lockedHolds,
	shippingShelves,
} from "./commitments-shelves";

export { ConsumeError } from "./commitments-shelves";

export type ConsumeInput = {
	orderId: number;
	lines: { orderLineId: number; quantity: number }[];
	fulfillmentKey: string;
};

export type ConsumedLine = {
	orderLineId: number;
	quantity: number;
	batchId: string;
	repeated: boolean;
};

export type UntrackedLine = {
	orderLineId: number;
	quantity: number;
	why: "sold_at_ingest" | "shipped_unreserved";
	repeated: boolean;
};

export type ConsumeResult =
	| { kind: "legacy" }
	| { kind: "consumed"; lines: ConsumedLine[]; untracked: UntrackedLine[] };

const restored = sql<boolean>`exists (select 1 from ${stockCommitmentEntries} r where r.restores_entry_id = ${stockCommitmentEntries.id})`;

export async function entriesUnder(
	db: Db,
	orderLineIds: number[],
	fulfillmentKey: string,
) {
	if (orderLineIds.length === 0) return [];
	return db
		.select({
			id: stockCommitmentEntries.id,
			commitmentId: stockCommitmentEntries.commitmentId,
			orderLineId: stockCommitments.orderLineId,
			quantity: stockCommitmentEntries.quantity,
			batchId: sql<string>`${stockCommitmentEntries.batchId}`,
			restored,
		})
		.from(stockCommitmentEntries)
		.innerJoin(
			stockCommitments,
			eq(stockCommitments.id, stockCommitmentEntries.commitmentId),
		)
		.where(
			and(
				inArray(stockCommitments.orderLineId, orderLineIds),
				eq(stockCommitmentEntries.kind, "consume"),
				eq(stockCommitmentEntries.fulfillmentKey, fulfillmentKey),
			),
		)
		.orderBy(stockCommitmentEntries.id);
}

export async function evidenceUnder(
	db: Db,
	orderLineIds: number[],
	fulfillmentKey?: string,
) {
	if (orderLineIds.length === 0) return [];
	const rows = await db
		.select()
		.from(unreservedShipments)
		.where(
			and(
				inArray(unreservedShipments.orderLineId, orderLineIds),
				fulfillmentKey === undefined
					? undefined
					: eq(unreservedShipments.fulfillmentKey, fulfillmentKey),
			),
		)
		.orderBy(unreservedShipments.id);
	const shipped = rows.filter((r) => r.kind === "shipped");
	return shipped.map((r) => ({
		orderLineId: r.orderLineId,
		fulfillmentKey: r.fulfillmentKey,
		quantity: r.quantity,
		voided: rows.some(
			(v) =>
				v.kind === "voided" &&
				v.orderLineId === r.orderLineId &&
				v.fulfillmentKey === r.fulfillmentKey,
		),
	}));
}

export function splitOverOpen(history: LineHistory, quantity: number) {
	const takes: {
		commitmentId: number;
		quantity: number;
		parts: LineHistory["open"][number]["parts"];
	}[] = [];
	let left = quantity;
	for (const revision of history.open) {
		if (left === 0) break;
		const take = Math.min(left, revision.remaining);
		takes.push({
			commitmentId: revision.id,
			quantity: take,
			parts: revision.parts,
		});
		left -= take;
	}
	return left === 0 ? takes : null;
}

export async function consumeCommitments(
	db: Db,
	input: ConsumeInput,
): Promise<ConsumeResult> {
	const key = input.fulfillmentKey.trim();
	if (key.length === 0) throw new ConsumeError("A fulfillment needs a key");
	const ids = input.lines.map((l) => l.orderLineId);
	if (new Set(ids).size !== ids.length)
		throw new ConsumeError("Each order line ships once per fulfillment");
	for (const l of input.lines)
		if (!Number.isInteger(l.quantity) || l.quantity <= 0)
			throw new ConsumeError(
				`Shipped quantities are whole numbers above 0, got ${l.quantity}`,
			);
	return db.transaction(async (tx) => {
		if ((await readQuantityMode(tx)) === "legacy") return { kind: "legacy" };
		await tx
			.select({ id: orders.id })
			.from(orders)
			.where(eq(orders.id, input.orderId))
			.for("no key update");
		const rows =
			ids.length === 0
				? []
				: await tx
						.select({ id: orderLines.id, saleBatchId: orderLines.saleBatchId })
						.from(orderLines)
						.where(
							and(
								eq(orderLines.orderId, input.orderId),
								inArray(orderLines.id, ids),
							),
						);
		if (rows.length !== ids.length)
			throw new ConsumeError(
				`Some of those lines aren't on order ${input.orderId}`,
			);
		const locked = new Set(
			[...(await lineHistories(tx, ids)).values()].flatMap((h) =>
				h.revisions.flatMap((r) => r.parts.map((p) => p.productId)),
			),
		);
		await lockStockProducts(tx, [...locked]);
		const histories = await lineHistories(tx, ids);
		const earlier = await entriesUnder(tx, ids, key);
		const evidence = await evidenceUnder(tx, ids, key);
		const consumed: ConsumedLine[] = [];
		const untracked: UntrackedLine[] = [];
		const pending: {
			orderLineId: number;
			quantity: number;
			takes: NonNullable<ReturnType<typeof splitOverOpen>>;
		}[] = [];
		for (const line of input.lines) {
			const seen = earlier.filter((e) => e.orderLineId === line.orderLineId);
			const proof = evidence.find((e) => e.orderLineId === line.orderLineId);
			if (seen.some((e) => e.restored) || proof?.voided)
				throw new ConsumeError(
					`Fulfillment ${key} was voided; ship it under a new key`,
				);
			const history = histories.get(line.orderLineId);
			if (seen.length > 0) {
				const total = seen.reduce((n, e) => n + e.quantity, 0);
				if (total !== line.quantity)
					throw new ConsumeError(
						`Fulfillment ${key} already shipped ${total} of line ${line.orderLineId}, not ${line.quantity}`,
					);
				consumed.push({ ...line, batchId: seen[0].batchId, repeated: true });
				continue;
			}
			if (!history || history.revisions.length === 0) {
				if (proof) {
					if (proof.quantity !== line.quantity)
						throw new ConsumeError(
							`Fulfillment ${key} already shipped ${proof.quantity} of line ${line.orderLineId}, not ${line.quantity}`,
						);
					untracked.push({
						...line,
						why: "shipped_unreserved",
						repeated: true,
					});
					continue;
				}
				const row = rows.find((r) => r.id === line.orderLineId);
				if (row?.saleBatchId) {
					untracked.push({ ...line, why: "sold_at_ingest", repeated: false });
					continue;
				}
				await tx.insert(unreservedShipments).values({
					orderLineId: line.orderLineId,
					orderId: input.orderId,
					kind: "shipped",
					fulfillmentKey: key,
					quantity: line.quantity,
				});
				untracked.push({ ...line, why: "shipped_unreserved", repeated: false });
				continue;
			}
			const takes = splitOverOpen(history, line.quantity);
			if (!takes)
				throw new ConsumeError(
					`Line ${line.orderLineId} has ${history.remaining} reserved, not ${line.quantity}`,
				);
			if (takes.some((t) => t.parts.some((p) => !locked.has(p.productId))))
				throw new ConsumeError(
					`Line ${line.orderLineId} changed while shipping; try again`,
				);
			pending.push({ ...line, takes });
		}
		if (pending.length === 0)
			return { kind: "consumed", lines: consumed, untracked };
		const shelves = await shippingShelves(tx);
		const holds = await lockedHolds(
			tx,
			[
				...new Set(
					pending.flatMap((p) =>
						p.takes.flatMap((t) => t.parts.map((x) => x.productId)),
					),
				),
			],
			shelves,
		);
		for (const line of pending) {
			const units = new Map<number, number>();
			for (const t of line.takes)
				for (const p of t.parts)
					units.set(
						p.productId,
						(units.get(p.productId) ?? 0) + p.perUnit * t.quantity,
					);
			const { batchId } = await postMovements(tx, {
				reference: `order:${input.orderId}:${line.orderLineId}`,
				lines: allocate(
					shelves,
					[...units].map(([productId, quantity]) => ({ productId, quantity })),
					holds,
				),
			});
			await tx.insert(stockCommitmentEntries).values(
				line.takes.map((t) => ({
					commitmentId: t.commitmentId,
					kind: "consume" as const,
					quantity: t.quantity,
					fulfillmentKey: key,
					batchId,
				})),
			);
			consumed.push({
				orderLineId: line.orderLineId,
				quantity: line.quantity,
				batchId,
				repeated: false,
			});
		}
		return { kind: "consumed", lines: consumed, untracked };
	});
}

export async function returnSaleOf(
	db: Db,
	orderLineId: number,
): Promise<{ batchId: string; quantity: number } | null> {
	const [entry] = await db
		.select({
			batchId: sql<string>`${stockCommitmentEntries.batchId}`,
			quantity: sql<number>`sum(${stockCommitmentEntries.quantity})::int`,
		})
		.from(stockCommitmentEntries)
		.innerJoin(
			stockCommitments,
			eq(stockCommitments.id, stockCommitmentEntries.commitmentId),
		)
		.where(
			and(
				eq(stockCommitments.orderLineId, orderLineId),
				eq(stockCommitmentEntries.kind, "consume"),
				sql`not ${restored}`,
			),
		)
		.groupBy(stockCommitmentEntries.batchId)
		.orderBy(sql`min(${stockCommitmentEntries.id})`)
		.limit(1);
	return entry
		? { batchId: entry.batchId, quantity: Number(entry.quantity) }
		: null;
}

export async function fulfillmentOfBatch(
	db: Db,
	batchId: string,
): Promise<{ orderId: number; fulfillmentKey: string } | null> {
	const [row] = await db
		.select({
			orderId: stockCommitments.orderId,
			fulfillmentKey: sql<string>`${stockCommitmentEntries.fulfillmentKey}`,
		})
		.from(stockCommitmentEntries)
		.innerJoin(
			stockCommitments,
			eq(stockCommitments.id, stockCommitmentEntries.commitmentId),
		)
		.where(
			and(
				eq(stockCommitmentEntries.batchId, batchId),
				eq(stockCommitmentEntries.kind, "consume"),
			),
		)
		.limit(1);
	return row ?? null;
}
