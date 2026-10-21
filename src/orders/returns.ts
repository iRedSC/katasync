import { and, eq, inArray, sql } from "drizzle-orm";
import { saleLocation, stockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import { orderLines, orderProfit, orderReturns, orders } from "#/db/schema";
import { recordReturn, undoBatch } from "#/inventory/ledger";
import { isLabeled, returnBlocker } from "./status";

export class ReturnError extends Error {
	name = "ReturnError";
}

// Receives units a customer sent back. Restocked units go back where the
// order takes stock from: the retail store for an in-store sale, the
// warehouse for a shipped one (where the box comes back to), even when some
// of it came from the store. Written-off ones (damaged) are only recorded.
// A line can't take back more than it sold, counting earlier returns.
// Returns are received here whatever the channel says: katasync owns stock,
// so a restock clicked in Shopify would only be overwritten.
export async function receiveReturn(
	db: Db,
	input: {
		orderId: number;
		lines: { lineId: number; quantity: number }[];
		restock: boolean;
	},
): Promise<{ ids: number[] }> {
	const wanted = input.lines.filter((l) => l.quantity > 0);
	if (wanted.length === 0) throw new ReturnError("Nothing to return");
	return db.transaction(async (tx) => {
		// Locks the order so two people receiving the same box can't both
		// count it.
		const [order] = await tx
			.select()
			.from(orders)
			.where(eq(orders.id, input.orderId))
			.for("update");
		if (!order) throw new ReturnError(`No order ${input.orderId}`);
		// order_profit has no row for a cancelled order, which the rule
		// turns away before asking whether it shipped.
		const [profit] = await tx
			.select({ labelsStatus: orderProfit.labelsStatus })
			.from(orderProfit)
			.where(eq(orderProfit.orderId, order.id));
		const blocked = returnBlocker({
			...order,
			labeled: isLabeled(profit?.labelsStatus),
		});
		if (blocked) throw new ReturnError(blocked);
		let restockAt: number | null = null;
		if (input.restock) {
			const shelf = saleLocation(await stockLocations(tx), order);
			if ("problem" in shelf)
				throw new ReturnError(`Can't restock: ${shelf.problem}`);
			restockAt = shelf.locationId;
		}

		const lines = await tx
			.select({
				id: orderLines.id,
				productId: orderLines.productId,
				sku: orderLines.sku,
				title: orderLines.title,
				quantity: orderLines.quantity,
				saleBatchId: orderLines.saleBatchId,
				// The outer table is named: in a one-table select Drizzle leaves
				// it off, and the subquery would compare its own columns.
				returned: sql<number>`coalesce((
					select sum(r.quantity) from ${orderReturns} r
					where r.order_line_id = "order_lines"."id"
				), 0)::int`,
			})
			.from(orderLines)
			.where(
				and(
					eq(orderLines.orderId, order.id),
					inArray(
						orderLines.id,
						wanted.map((w) => w.lineId),
					),
				),
			);

		const ids: number[] = [];
		for (const want of wanted) {
			const line = lines.find((l) => l.id === want.lineId);
			if (!line)
				throw new ReturnError(`No line ${want.lineId} on ${order.name}`);
			const name = line.sku ?? line.title;
			const left = line.quantity - line.returned;
			if (!Number.isInteger(want.quantity) || want.quantity > left) {
				throw new ReturnError(
					left === 0
						? `${name} was already returned`
						: `Only ${left} of ${name} can still come back`,
				);
			}
			let batchId: string | null = null;
			if (restockAt !== null) {
				if (line.productId === null) {
					throw new ReturnError(
						`Match ${name} to a product before putting it back on the shelf`,
					);
				}
				({ batchId } = await recordReturn(tx, {
					productId: line.productId,
					quantity: want.quantity,
					locationId: restockAt,
					reference: `return:${order.id}:${line.id}`,
					sale: line.saleBatchId
						? { batchId: line.saleBatchId, quantity: line.quantity }
						: null,
				}));
			}
			const [row] = await tx
				.insert(orderReturns)
				.values({
					orderLineId: line.id,
					quantity: want.quantity,
					restocked: batchId !== null,
					batchId,
				})
				.returning({ id: orderReturns.id });
			ids.push(row.id);
			line.returned += want.quantity;
		}
		return { ids };
	});
}

// Takes returns back off, e.g. from the Undo after receiving: restocked
// units leave the shelf again. All or none: one already taken off (a second
// click, or another tab) fails the lot rather than half undoing it.
export async function undoReturns(db: Db, ids: number[]) {
	if (ids.length === 0) return;
	await db.transaction(async (tx) => {
		const rows = await tx
			.delete(orderReturns)
			.where(inArray(orderReturns.id, ids))
			.returning();
		if (rows.length !== new Set(ids).size)
			throw new ReturnError("That return was already undone");
		for (const row of rows) {
			if (row.batchId) await undoBatch(tx, row.batchId);
		}
	});
}
