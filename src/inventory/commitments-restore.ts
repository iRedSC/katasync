import { and, eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	stockCommitmentEntries,
	stockCommitments,
	unreservedShipments,
} from "#/db/quantity-schema";
import { orders } from "#/db/schema";
import { undoBatch } from "#/inventory/ledger";
import { batchProductIds, lockRecipes } from "#/inventory/ledger/post";
import {
	lineHistories,
	lineTargets,
	partsFor,
	readQuantityMode,
	type Settlement,
	settleLine,
} from "./commitments";

export type RestoreResult =
	| { kind: "legacy" }
	| {
			kind: "restored";
			lines: { orderLineId: number; quantity: number; settled: Settlement }[];
			voidedUnreserved: { orderLineId: number; quantity: number }[];
	  };

export async function restoreCommitments(
	db: Db,
	input: { orderId: number; fulfillmentKey: string },
): Promise<RestoreResult> {
	const key = input.fulfillmentKey.trim();
	return db.transaction(async (tx) => {
		if ((await readQuantityMode(tx)) === "legacy") return { kind: "legacy" };
		await tx
			.select({ id: orders.id })
			.from(orders)
			.where(eq(orders.id, input.orderId))
			.for("no key update");
		const entries = await tx
			.select({
				id: stockCommitmentEntries.id,
				commitmentId: stockCommitmentEntries.commitmentId,
				orderLineId: stockCommitments.orderLineId,
				quantity: stockCommitmentEntries.quantity,
				batchId: sql<string>`${stockCommitmentEntries.batchId}`,
			})
			.from(stockCommitmentEntries)
			.innerJoin(
				stockCommitments,
				eq(stockCommitments.id, stockCommitmentEntries.commitmentId),
			)
			.where(
				and(
					eq(stockCommitments.orderId, input.orderId),
					eq(stockCommitmentEntries.kind, "consume"),
					eq(stockCommitmentEntries.fulfillmentKey, key),
					sql`not exists (select 1 from ${stockCommitmentEntries} r where r.restores_entry_id = ${stockCommitmentEntries.id})`,
				),
			)
			.orderBy(stockCommitmentEntries.id);
		const shipped = await tx
			.select()
			.from(unreservedShipments)
			.where(
				and(
					eq(unreservedShipments.orderId, input.orderId),
					eq(unreservedShipments.fulfillmentKey, key),
				),
			);
		const unvoided = shipped.filter(
			(s) =>
				s.kind === "shipped" &&
				!shipped.some(
					(v) => v.kind === "voided" && v.orderLineId === s.orderLineId,
				),
		);
		if (unvoided.length > 0)
			await tx.insert(unreservedShipments).values(
				unvoided.map((s) => ({
					orderLineId: s.orderLineId,
					orderId: s.orderId,
					kind: "voided" as const,
					fulfillmentKey: key,
					quantity: s.quantity,
				})),
			);
		const voidedUnreserved = unvoided
			.filter((s) => !entries.some((e) => e.orderLineId === s.orderLineId))
			.map((s) => ({ orderLineId: s.orderLineId, quantity: s.quantity }));
		if (entries.length === 0)
			return { kind: "restored", lines: [], voidedUnreserved };
		const lineIds = [...new Set(entries.map((e) => e.orderLineId))];
		const batches = [...new Set(entries.map((e) => e.batchId))];
		const targets = await lineTargets(tx, lineIds);
		const before = await lineHistories(tx, lineIds);
		const { products, recipes } = await lockRecipes(
			tx,
			targets.flatMap((t) => (t.productId === null ? [] : [t.productId])),
			[
				...(await batchProductIds(tx, batches)),
				...[...before.values()].flatMap((h) =>
					h.revisions.flatMap((r) => r.parts.map((p) => p.productId)),
				),
			],
		);
		for (const batchId of batches) await undoBatch(tx, batchId);
		await tx.insert(stockCommitmentEntries).values(
			entries.map((e) => ({
				commitmentId: e.commitmentId,
				kind: "restore" as const,
				quantity: e.quantity,
				batchId: e.batchId,
				restoresEntryId: e.id,
			})),
		);
		const lines: {
			orderLineId: number;
			quantity: number;
			settled: Settlement;
		}[] = [];
		for (const t of targets) {
			const quantity = entries
				.filter((e) => e.orderLineId === t.orderLineId)
				.reduce((n, e) => n + e.quantity, 0);
			const productId =
				t.productId ?? before.get(t.orderLineId)?.latest?.productId ?? null;
			if (productId === null) continue;
			const settled = await settleLine(tx, {
				orderLineId: t.orderLineId,
				orderId: t.orderId,
				productId,
				target: t.target,
				freshParts: async () => {
					const product = products.find((p) => p.id === productId);
					return product ? partsFor(product, recipes) : null;
				},
			});
			lines.push({ orderLineId: t.orderLineId, quantity, settled });
		}
		return { kind: "restored", lines, voidedUnreserved };
	});
}
