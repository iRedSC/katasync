import { and, eq, inArray, sql } from "drizzle-orm";
import { saleLocation, stockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import {
	stockCommitmentEntries,
	stockCommitments,
} from "#/db/quantity-schema";
import { orderLines, stockLevels } from "#/db/schema";
import { type MovementLine, postMovements, undoBatch } from "#/inventory/ledger";
import { lockBatchProducts, lockStockProducts } from "#/inventory/ledger/post";
import { lineHistories, readQuantityMode } from "./commitments";

export class ConsumeError extends Error {
	name = "ConsumeError";
}

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
	why: "sold_at_ingest" | "never_reserved";
};

export type ConsumeResult =
	| { kind: "legacy" }
	| { kind: "consumed"; lines: ConsumedLine[]; untracked: UntrackedLine[] };

type Shelves = { main: number; overflow: { locationId: number; keep: number } | null };

export function allocate(
	shelves: Shelves,
	units: { productId: number; quantity: number }[],
	holds: Map<string, number>,
): MovementLine[] {
	const key = (productId: number, locationId: number) =>
		`${productId}:${locationId}`;
	const at = (productId: number, locationId: number) =>
		Math.max(0, holds.get(key(productId, locationId)) ?? 0);
	return units.flatMap((u) => {
		const first = Math.min(u.quantity, at(u.productId, shelves.main));
		const spare = shelves.overflow
			? Math.max(
					0,
					at(u.productId, shelves.overflow.locationId) - shelves.overflow.keep,
				)
			: 0;
		const spill = Math.min(u.quantity - first, spare);
		const main = u.quantity - spill;
		const lines: MovementLine[] = [];
		if (main > 0) {
			lines.push({
				productId: u.productId,
				locationId: shelves.main,
				delta: -main,
				reason: "sale",
			});
			holds.set(
				key(u.productId, shelves.main),
				(holds.get(key(u.productId, shelves.main)) ?? 0) - main,
			);
		}
		if (spill > 0 && shelves.overflow) {
			const id = shelves.overflow.locationId;
			lines.push({
				productId: u.productId,
				locationId: id,
				delta: -spill,
				reason: "sale",
			});
			holds.set(key(u.productId, id), at(u.productId, id) - spill);
		}
		return lines;
	});
}

async function shippingShelves(db: Db): Promise<Shelves> {
	const shelf = saleLocation(await stockLocations(db), { soldInStore: false });
	if ("problem" in shelf) throw new ConsumeError(shelf.problem);
	return {
		main: shelf.locationId,
		overflow:
			shelf.overflow && shelf.overflow.locationId !== shelf.locationId
				? shelf.overflow
				: null,
	};
}

async function lockedHolds(db: Db, productIds: number[], shelves: Shelves) {
	const locationIds = [
		shelves.main,
		...(shelves.overflow ? [shelves.overflow.locationId] : []),
	];
	const rows =
		productIds.length === 0
			? []
			: await db
					.select()
					.from(stockLevels)
					.where(
						and(
							inArray(stockLevels.productId, productIds),
							inArray(stockLevels.locationId, locationIds),
						),
					)
					.orderBy(stockLevels.productId, stockLevels.locationId)
					.for("update");
	return new Map(rows.map((r) => [`${r.productId}:${r.locationId}`, r.onHand]));
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
		const seenParts = [...(await lineHistories(tx, ids)).values()].flatMap(
			(h) => h.revisions.flatMap((r) => r.parts.map((p) => p.productId)),
		);
		const locked = new Set(seenParts);
		await lockStockProducts(tx, [...locked]);
		const histories = await lineHistories(tx, ids);
		const earlier =
			ids.length === 0
				? []
				: await tx
						.select({
							orderLineId: stockCommitments.orderLineId,
							quantity: stockCommitmentEntries.quantity,
							batchId: stockCommitmentEntries.batchId,
							restored: sql<boolean>`exists (select 1 from ${stockCommitmentEntries} r where r.restores_entry_id = ${stockCommitmentEntries.id})`,
						})
						.from(stockCommitmentEntries)
						.innerJoin(
							stockCommitments,
							eq(stockCommitments.id, stockCommitmentEntries.commitmentId),
						)
						.where(
							and(
								inArray(stockCommitments.orderLineId, ids),
								eq(stockCommitmentEntries.kind, "consume"),
								eq(stockCommitmentEntries.fulfillmentKey, key),
							),
						);
		const consumed: ConsumedLine[] = [];
		const untracked: UntrackedLine[] = [];
		const pending: {
			orderLineId: number;
			quantity: number;
			commitmentId: number;
			units: { productId: number; quantity: number }[];
		}[] = [];
		for (const line of input.lines) {
			const seen = earlier.find((e) => e.orderLineId === line.orderLineId);
			if (seen) {
				if (seen.restored)
					throw new ConsumeError(
						`Fulfillment ${key} was voided; ship it under a new key`,
					);
				if (seen.quantity !== line.quantity || !seen.batchId)
					throw new ConsumeError(
						`Fulfillment ${key} already shipped ${seen.quantity} of line ${line.orderLineId}, not ${line.quantity}`,
					);
				consumed.push({ ...line, batchId: seen.batchId, repeated: true });
				continue;
			}
			const latest = histories.get(line.orderLineId)?.latest ?? null;
			if (!latest) {
				const row = rows.find((r) => r.id === line.orderLineId);
				untracked.push({
					...line,
					why: row?.saleBatchId ? "sold_at_ingest" : "never_reserved",
				});
				continue;
			}
			if (latest.parts.some((p) => !locked.has(p.productId)))
				throw new ConsumeError(
					`Line ${line.orderLineId} changed while shipping; try again`,
				);
			if (latest.remaining < line.quantity)
				throw new ConsumeError(
					`Line ${line.orderLineId} has ${latest.remaining} reserved, not ${line.quantity}`,
				);
			pending.push({
				...line,
				commitmentId: latest.id,
				units: latest.parts.map((p) => ({
					productId: p.productId,
					quantity: p.perUnit * line.quantity,
				})),
			});
		}
		if (pending.length === 0)
			return { kind: "consumed", lines: consumed, untracked };
		const productIds = [
			...new Set(pending.flatMap((p) => p.units.map((u) => u.productId))),
		];
		const shelves = await shippingShelves(tx);
		const holds = await lockedHolds(tx, productIds, shelves);
		for (const line of pending) {
			const { batchId } = await postMovements(tx, {
				reference: `order:${input.orderId}:${line.orderLineId}`,
				lines: allocate(shelves, line.units, holds),
			});
			await tx.insert(stockCommitmentEntries).values({
				commitmentId: line.commitmentId,
				kind: "consume",
				quantity: line.quantity,
				fulfillmentKey: key,
				batchId,
			});
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

export type RestoreResult =
	| { kind: "legacy" }
	| { kind: "restored"; lines: { orderLineId: number; quantity: number }[] };

export async function restoreCommitments(
	db: Db,
	input: { orderId: number; fulfillmentKey: string },
): Promise<RestoreResult> {
	return db.transaction(async (tx) => {
		if ((await readQuantityMode(tx)) === "legacy") return { kind: "legacy" };
		const entries = await tx
			.select({
				id: stockCommitmentEntries.id,
				commitmentId: stockCommitmentEntries.commitmentId,
				orderLineId: stockCommitments.orderLineId,
				quantity: stockCommitmentEntries.quantity,
				batchId: stockCommitmentEntries.batchId,
			})
			.from(stockCommitmentEntries)
			.innerJoin(
				stockCommitments,
				eq(stockCommitments.id, stockCommitmentEntries.commitmentId),
			)
			.where(
				and(
					eq(stockCommitments.orderId, input.orderId),
					eq(stockCommitmentEntries.fulfillmentKey, input.fulfillmentKey),
					eq(stockCommitmentEntries.kind, "consume"),
				),
			)
			.orderBy(stockCommitmentEntries.id);
		const done =
			entries.length === 0
				? []
				: await tx
						.select({ restoresEntryId: stockCommitmentEntries.restoresEntryId })
						.from(stockCommitmentEntries)
						.where(
							inArray(
								stockCommitmentEntries.restoresEntryId,
								entries.map((e) => e.id),
							),
						);
		const open = entries.filter(
			(e) => !done.some((d) => d.restoresEntryId === e.id),
		);
		if (open.length === 0) return { kind: "restored", lines: [] };
		const histories = await lineHistories(
			tx,
			open.map((e) => e.orderLineId),
		);
		await lockBatchProducts(
			tx,
			open.flatMap((e) => (e.batchId ? [e.batchId] : [])),
			[...histories.values()].flatMap((h) =>
				h.revisions.flatMap((r) => r.parts.map((p) => p.productId)),
			),
		);
		for (const entry of open) {
			if (!entry.batchId) continue;
			await undoBatch(tx, entry.batchId);
			await tx.insert(stockCommitmentEntries).values({
				commitmentId: entry.commitmentId,
				kind: "restore",
				quantity: entry.quantity,
				batchId: entry.batchId,
				restoresEntryId: entry.id,
			});
		}
		return {
			kind: "restored",
			lines: open.map((e) => ({
				orderLineId: e.orderLineId,
				quantity: e.quantity,
			})),
		};
	});
}

export async function returnSaleOf(
	db: Db,
	orderLineId: number,
): Promise<{ batchId: string; quantity: number } | null> {
	const [entry] = await db
		.select({
			batchId: stockCommitmentEntries.batchId,
			quantity: stockCommitmentEntries.quantity,
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
				sql`not exists (select 1 from ${stockCommitmentEntries} r where r.restores_entry_id = ${stockCommitmentEntries.id})`,
			),
		)
		.orderBy(stockCommitmentEntries.id)
		.limit(1);
	return entry?.batchId ? { batchId: entry.batchId, quantity: entry.quantity } : null;
}
