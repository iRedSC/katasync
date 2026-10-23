import { and, eq, inArray, sql } from "drizzle-orm";
import { saleLocation, stockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import {
	locations,
	orderLines,
	orderProfit,
	orderReturns,
	orders,
	products,
	stockLevels,
} from "#/db/schema";
import { recordReturn, undoBatch } from "#/inventory/ledger";
import { lockBatchProducts } from "#/inventory/ledger/post";
import { isOurs } from "#/inventory/locations";
import { retireRefurbs } from "./refurb-retire";
import { isLabeled, returnBlocker } from "./status";

export class ReturnError extends Error {
	name = "ReturnError";
}

// What becomes of returned units: back on the shelf as what they sold as,
// on the shelf as a refurbished one-off (made by src/orders/refurbish.ts),
// or written off as damaged.
export type ReturnOutcome = "restock" | "write_off" | { refurbishInto: number };

// Receives units a customer sent back. Restocked units go back where the
// order takes stock from: the retail store for an in-store sale, the
// warehouse for a shipped one (where the box comes back to), even when some
// of it came from the store; refurbished ones go to the same shelf as their
// refurb. Written-off ones (damaged) are only recorded. A refurb takes one
// line's units, from the product it was made from.
// A line can't take back more than it sold, counting earlier returns.
// Returns are received here whatever the channel says: katasync owns stock,
// so a restock clicked in Shopify would only be overwritten.
export async function receiveReturn(
	db: Db,
	input: {
		orderId: number;
		lines: { lineId: number; quantity: number }[];
		outcome: ReturnOutcome;
	},
): Promise<{ ids: number[] }> {
	const wanted = input.lines.filter((l) => l.quantity > 0);
	if (wanted.length === 0) throw new ReturnError("Nothing to return");
	const refurb =
		typeof input.outcome === "object" ? input.outcome.refurbishInto : null;
	if (refurb !== null && wanted.length > 1)
		throw new ReturnError("Refurbish one item at a time");
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
		if (input.outcome !== "write_off") {
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
				unitCost: orderLines.unitCost,
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

		if (restockAt !== null)
			await lockBatchProducts(
				tx,
				lines.flatMap((line) =>
					line.saleBatchId === null ? [] : [line.saleBatchId],
				),
				[
					...lines.flatMap((line) =>
						line.productId === null ? [] : [line.productId],
					),
					...(refurb === null ? [] : [refurb]),
				],
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
			if (restockAt !== null && line.productId === null) {
				throw new ReturnError(
					`Match ${name} to a product before putting it back on the shelf`,
				);
			}
			if (refurb !== null && restockAt !== null && line.productId !== null) {
				const [into] = await tx
					.select({
						sku: products.sku,
						from: products.refurbishedFromId,
						archivedAt: products.archivedAt,
					})
					.from(products)
					.where(eq(products.id, refurb))
					.for("share");
				if (!into || into.from !== line.productId)
					throw new ReturnError(`That refurb isn't made from ${name}`);
				if (into.archivedAt)
					throw new ReturnError(`${into.sku} is archived; make a new refurb`);
				({ batchId } = await recordReturn(tx, {
					productId: refurb,
					quantity: want.quantity,
					locationId: restockAt,
					reference: `return:${order.id}:${line.id}`,
					sale: null,
					unitCost: line.unitCost,
				}));
			} else if (restockAt !== null && line.productId !== null) {
				({ batchId } = await recordReturn(tx, {
					productId: line.productId,
					quantity: want.quantity,
					locationId: restockAt,
					reference: `return:${order.id}:${line.id}`,
					sale: line.saleBatchId
						? { batchId: line.saleBatchId, quantity: line.quantity }
						: null,
					unitCost: line.unitCost,
				}));
			}
			const [row] = await tx
				.insert(orderReturns)
				.values({
					orderLineId: line.id,
					quantity: want.quantity,
					restocked: input.outcome === "restock",
					refurbProductId: refurb,
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
// click, or another tab) fails the lot rather than half undoing it. A
// refurb's units can only come off while it still has them; one left empty
// that never sold is deleted from Shopify and archived, as if never made.
// What went wrong cleaning one up comes back as problems; the undo stands.
export async function undoReturns(
	db: Db,
	ids: number[],
): Promise<{ problems: string[] }> {
	if (ids.length === 0) return { problems: [] };
	const refurbs = await db.transaction(async (tx) => {
		const rows = await tx
			.delete(orderReturns)
			.where(inArray(orderReturns.id, ids))
			.returning();
		if (rows.length !== new Set(ids).size)
			throw new ReturnError("That return was already undone");
		await lockBatchProducts(
			tx,
			rows.flatMap((row) => (row.batchId === null ? [] : [row.batchId])),
			rows.flatMap((row) =>
				row.refurbProductId === null ? [] : [row.refurbProductId],
			),
		);
		for (const row of rows) {
			if (row.refurbProductId !== null) {
				const [refurb] = await tx
					.select({ sku: products.sku })
					.from(products)
					.where(eq(products.id, row.refurbProductId))
					.for("update");
				const [{ onHand }] = await tx
					.select({
						onHand: sql<number>`coalesce(sum(${stockLevels.onHand}), 0)::int`,
					})
					.from(stockLevels)
					.innerJoin(locations, eq(locations.id, stockLevels.locationId))
					.where(and(eq(stockLevels.productId, row.refurbProductId), isOurs));
				if (onHand < row.quantity)
					throw new ReturnError(
						`${refurb.sku} has sold since, so its return can't come off`,
					);
			}
			if (row.batchId) await undoBatch(tx, row.batchId);
		}
		return [...new Set(rows.flatMap((r) => r.refurbProductId ?? []))];
	});
	return retireRefurbs(db, refurbs);
}
