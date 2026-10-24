import { and, eq, inArray, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import { type StockLocations, saleLocation } from "#/channels/stores";
import type { Db } from "#/db/client";
import { stockCommitmentParts, stockCommitments } from "#/db/quantity-schema";
import { orderLines, orders } from "#/db/schema";
import {
	CommitmentError,
	lineHasCommitment,
	lineHistory,
	partsFor,
	readQuantityMode,
	settleLine,
} from "#/inventory/commitments";
import {
	ConsumeError,
	consumeCommitments,
	entriesUnder,
	evidenceUnder,
} from "#/inventory/commitments-consume";
import { LedgerError, recordSale } from "#/inventory/ledger";
import { lockRecipes } from "#/inventory/ledger/post";

export type StockEffect =
	| { kind: "none" }
	| { kind: "sold"; batchId: string }
	| { kind: "shipped_unreserved"; shipped: number }
	| { kind: "reserved"; remaining: number; consumed: number }
	| { kind: "released"; consumed: number };

export const stockEffectApplied = or(
	isNotNull(orderLines.saleBatchId),
	lineHasCommitment,
);

export const stockEffectMissing = and(
	isNull(orderLines.saleBatchId),
	not(lineHasCommitment),
);

export const outstandingShipment = sql<boolean>`exists (
	select 1 from unreserved_shipments s
	where s.order_line_id = ${orderLines.id} and s.kind = 'shipped'
	and not exists (select 1 from unreserved_shipments v where v.order_line_id = s.order_line_id and v.fulfillment_key = s.fulfillment_key and v.kind = 'voided')
	and not exists (select 1 from stock_commitment_entries e join stock_commitments c on c.id = e.commitment_id where c.order_line_id = s.order_line_id and e.fulfillment_key = s.fulfillment_key and e.kind = 'consume')
)`;

export async function lineStockEffect(
	db: Db,
	line: { id: number; saleBatchId: string | null },
): Promise<StockEffect> {
	if (line.saleBatchId) return { kind: "sold", batchId: line.saleBatchId };
	const history = await lineHistory(db, line.id);
	if (!history.latest) {
		const shipped = (await evidenceUnder(db, [line.id]))
			.filter((e) => !e.voided)
			.reduce((n, e) => n + e.quantity, 0);
		return shipped > 0
			? { kind: "shipped_unreserved", shipped }
			: { kind: "none" };
	}
	return history.remaining > 0
		? {
				kind: "reserved",
				remaining: history.remaining,
				consumed: history.consumed,
			}
		: { kind: "released", consumed: history.consumed };
}

export async function commitmentProductIds(db: Db, orderLineIds: number[]) {
	if (orderLineIds.length === 0) return [];
	const rows = await db
		.selectDistinct({ productId: stockCommitmentParts.productId })
		.from(stockCommitmentParts)
		.innerJoin(
			stockCommitments,
			eq(stockCommitments.id, stockCommitmentParts.commitmentId),
		)
		.where(inArray(stockCommitments.orderLineId, orderLineIds));
	return rows.map((r) => r.productId);
}

type Line = {
	id: number;
	orderId: number;
	productId: number;
	quantity: number;
};

async function reserve(
	db: Db,
	line: Line,
	target: number,
	order: { name: string },
): Promise<string | null> {
	try {
		return await db.transaction(async (tx) => {
			await readQuantityMode(tx);
			await tx
				.select({ id: orders.id })
				.from(orders)
				.where(eq(orders.id, line.orderId))
				.for("no key update");
			const settle = (quantity: number) =>
				settleLine(tx, {
					orderLineId: line.id,
					orderId: line.orderId,
					productId: line.productId,
					target: quantity,
					freshParts: async (tx) => {
						const { products, recipes } = await lockRecipes(tx, [
							line.productId,
						]);
						const product = products.find((p) => p.id === line.productId);
						return product ? partsFor(product, recipes) : null;
					},
				});
			const proofs = (await evidenceUnder(tx, [line.id])).filter(
				(proof) => !proof.voided,
			);
			const pending = await Promise.all(
				proofs.map(async (proof) =>
					(await entriesUnder(tx, [line.id], proof.fulfillmentKey)).length === 0
						? proof.quantity
						: 0,
				),
			);
			const history = await lineHistory(tx, line.id);
			await settle(
				Math.max(
					target,
					history.consumed +
						pending.reduce((total, quantity) => total + quantity, 0),
				),
			);
			const problem = await applyShipped(tx, line, order);
			if (problem) throw new CommitmentError(problem);
			const settled = await settle(target);
			if (settled.kind === "overshipped")
				return `${order.name}: ${settled.consumed} already shipped, more than the ${settled.target} ordered now`;
			return null;
		});
	} catch (error) {
		if (!(error instanceof CommitmentError || error instanceof LedgerError))
			throw error;
		return `${order.name}: ${error.message}`;
	}
}

async function applyShipped(
	db: Db,
	line: Line,
	order: { name: string },
): Promise<string | null> {
	for (const proof of await evidenceUnder(db, [line.id])) {
		if (proof.voided) continue;
		if ((await entriesUnder(db, [line.id], proof.fulfillmentKey)).length > 0)
			continue;
		try {
			await consumeCommitments(db, {
				orderId: line.orderId,
				lines: [{ orderLineId: line.id, quantity: proof.quantity }],
				fulfillmentKey: proof.fulfillmentKey,
			});
		} catch (error) {
			if (!(error instanceof ConsumeError)) throw error;
			return `${order.name}: shipped ${proof.quantity} before it had a product, but ${error.message}`;
		}
	}
	return null;
}

export async function keepsShippedSale(
	db: Db,
	order: { soldInStore: boolean },
): Promise<boolean> {
	return !order.soldInStore && (await readQuantityMode(db)) === "committed";
}

export async function takeLineStock(
	db: Db,
	line: Line,
	order: { name: string; soldInStore: boolean },
	from: StockLocations,
): Promise<string | null> {
	if (!order.soldInStore && (await readQuantityMode(db)) === "committed")
		return reserve(db, line, line.quantity, order);
	const shelf = saleLocation(from, order);
	if ("problem" in shelf) return `${order.name}: ${shelf.problem}`;
	try {
		const sale = await recordSale(db, {
			productId: line.productId,
			quantity: line.quantity,
			locationId: shelf.locationId,
			overflow: shelf.overflow,
			reference: `order:${line.orderId}:${line.id}`,
		});
		await db
			.update(orderLines)
			.set({ saleBatchId: sale.batchId })
			.where(eq(orderLines.id, line.id));
		return null;
	} catch (error) {
		if (!(error instanceof LedgerError)) throw error;
		return `${order.name}: ${error.message}`;
	}
}

export async function syncLineStock(
	db: Db,
	input: {
		row: {
			id: number;
			orderId: number;
			productId: number | null;
			quantity: number;
		};
		sku: string | null;
		order: { name: string; soldInStore: boolean };
		takesStock: boolean;
		from: StockLocations;
	},
): Promise<string | null> {
	const { row, order } = input;
	const taking = input.takesStock && row.quantity > 0;
	if (row.productId === null)
		return taking && input.sku !== null
			? `${order.name}: no product for ${input.sku}`
			: null;
	const line = { ...row, productId: row.productId };
	if (taking) return takeLineStock(db, line, order, input.from);
	if (order.soldInStore || (await readQuantityMode(db)) === "legacy")
		return null;
	return reserve(db, line, 0, order);
}
