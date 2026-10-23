import { and, eq, inArray, isNotNull, isNull, not, or } from "drizzle-orm";
import { type StockLocations, saleLocation } from "#/channels/stores";
import type { Db } from "#/db/client";
import {
	stockCommitmentParts,
	stockCommitments,
} from "#/db/quantity-schema";
import { orderLines } from "#/db/schema";
import { LedgerError, recordSale } from "#/inventory/ledger";
import { lockRecipes } from "#/inventory/ledger/post";
import {
	CommitmentError,
	hasCommitment,
	lineHistory,
	partsFor,
	readQuantityMode,
	settleLine,
} from "#/inventory/commitments";

export type StockEffect =
	| { kind: "none" }
	| { kind: "sold"; batchId: string }
	| { kind: "reserved"; remaining: number; consumed: number }
	| { kind: "released"; consumed: number };

export const stockEffectApplied = or(
	isNotNull(orderLines.saleBatchId),
	hasCommitment(orderLines.id),
);

export const stockEffectMissing = and(
	isNull(orderLines.saleBatchId),
	not(hasCommitment(orderLines.id)),
);

export async function lineStockEffect(
	db: Db,
	line: { id: number; saleBatchId: string | null },
): Promise<StockEffect> {
	if (line.saleBatchId) return { kind: "sold", batchId: line.saleBatchId };
	const history = await lineHistory(db, line.id);
	if (!history.latest) return { kind: "none" };
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

type Line = { id: number; orderId: number; productId: number; quantity: number };

async function reserve(
	db: Db,
	line: Line,
	target: number,
	order: { name: string },
): Promise<string | null> {
	try {
		const settled = await settleLine(db, {
			orderLineId: line.id,
			orderId: line.orderId,
			productId: line.productId,
			target,
			freshParts: async () => {
				const { products, recipes } = await lockRecipes(db, [line.productId]);
				const product = products.find((p) => p.id === line.productId);
				return product ? partsFor(product, recipes) : null;
			},
		});
		return settled.kind === "overshipped"
			? `${order.name}: ${settled.consumed} already shipped, more than the ${settled.target} ordered now`
			: null;
	} catch (error) {
		if (!(error instanceof CommitmentError || error instanceof LedgerError))
			throw error;
		return `${order.name}: ${error.message}`;
	}
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
