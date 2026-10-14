import { and, eq, inArray, sql } from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import type { Db } from "#/db/client";
import { orderLines, orderReturns, orders } from "#/db/schema";
import { recordReturn, undoBatch } from "#/inventory/ledger";

export class ReturnError extends Error {
	name = "ReturnError";
}

// Statuses where something has left the building and can come back.
const shipped = ["FULFILLED"];

// Receives units a customer sent back. Restocked units go back on the
// shipping location's shelf; written-off ones (damaged) are only recorded.
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
		if (order.fulfilledByChannel) {
			throw new ReturnError(
				`${order.name} was shipped by the marketplace, so its returns go back there`,
			);
		}
		if (order.cancelledAt) {
			throw new ReturnError(
				`${order.name} was cancelled, so its stock already came back`,
			);
		}
		if (!shipped.includes(order.fulfillmentStatus)) {
			throw new ReturnError(
				order.fulfillmentStatus === "PARTIALLY_FULFILLED"
					? "Receive returns after the remaining items ship or are cancelled"
					: `${order.name} hasn't shipped yet`,
			);
		}
		const locationId = input.restock ? await shippingLocation(tx) : null;
		if (input.restock && locationId === null) {
			throw new ReturnError("No location to put returned stock in");
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
			if (input.restock && locationId !== null) {
				if (line.productId === null) {
					throw new ReturnError(
						`Match ${name} to a product before putting it back on the shelf`,
					);
				}
				({ batchId } = await recordReturn(tx, {
					productId: line.productId,
					quantity: want.quantity,
					locationId,
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
// units leave the shelf again.
export async function undoReturns(db: Db, ids: number[]) {
	if (ids.length === 0) return;
	await db.transaction(async (tx) => {
		const rows = await tx
			.delete(orderReturns)
			.where(inArray(orderReturns.id, ids))
			.returning();
		for (const row of rows) {
			if (row.batchId) await undoBatch(tx, row.batchId);
		}
	});
}
