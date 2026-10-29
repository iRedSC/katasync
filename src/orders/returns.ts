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
import { readQuantityMode } from "#/inventory/commitments";
import { returnSaleOf } from "#/inventory/commitments-consume";
import { recordReturn, undoBatch } from "#/inventory/ledger";
import { lockBatchProducts } from "#/inventory/ledger/post";
import { isOurs } from "#/inventory/locations";
import { onBench } from "#/repairs/bench-holds";
import { claimCutover, countedAtCutover, restoreCutover } from "./cutover";
import { retireRefurbs } from "./refurb-retire";
import { returnQuantity } from "./return-stock";
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
// A line can't take back more than it sold, counting earlier returns;
// units only counted back at cutover can be, taking them off that count
// (src/orders/cutover.ts).
// Returns are received here whatever the channel says: katasync owns stock,
// so a restock clicked in Shopify would only be overwritten.
// Units on the bench can't be received here, except by listing their job:
// `bench` names it, so its own unit can come in, gives the refurb's cost
// (the unit's plus its parts), and when the unit was counted at cutover.
// Only src/repairs/bench.ts passes it.
export async function receiveReturn(
	db: Db,
	input: {
		orderId: number;
		lines: { lineId: number; quantity: number }[];
		outcome: ReturnOutcome;
		// What whoever checked it in saw, for the refund decision.
		note?: string | null;
	},
	bench: {
		repairId: number;
		unitCost: number | null;
		cutoverAt: Date | null;
	} | null = null,
): Promise<{ ids: number[] }> {
	const wanted = input.lines.filter((l) => l.quantity > 0);
	if (wanted.length === 0) throw new ReturnError("Nothing to return");
	const refurb =
		typeof input.outcome === "object" ? input.outcome.refurbishInto : null;
	if (refurb !== null && wanted.length > 1)
		throw new ReturnError("Refurbish one item at a time");
	return db.transaction(async (tx) => {
		const mode = await readQuantityMode(tx);
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
		if (order.fulfilledByChannel || mode === "legacy") {
			if (blocked) throw new ReturnError(blocked);
		}
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
				returnQuantity,
				saleBatchId: orderLines.saleBatchId,
				unitCost: orderLines.unitCost,
				// The outer table is named: in a one-table select Drizzle leaves
				// it off, and the subquery would compare its own columns.
				returned: sql<number>`coalesce((
					select sum(r.quantity) from ${orderReturns} r
					where r.order_line_id = "order_lines"."id"
				), 0)::int`,
				onBench: onBench(bench?.repairId ?? null),
				counted: countedAtCutover,
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

		const sales = new Map(
			await Promise.all(
				lines.map(
					async (line) =>
						[
							line.id,
							line.saleBatchId
								? { batchId: line.saleBatchId, quantity: line.quantity }
								: await returnSaleOf(tx, line.id),
						] as const,
				),
			),
		);
		if (restockAt !== null)
			await lockBatchProducts(
				tx,
				[...sales.values()].flatMap((sale) =>
					sale === null ? [] : [sale.batchId],
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
			const left = line.returnQuantity - line.returned - line.onBench;
			if (
				!Number.isInteger(want.quantity) ||
				want.quantity > left + line.counted
			) {
				throw new ReturnError(
					left + line.counted === 0
						? line.onBench > 0
							? `${name} is on the bench; list it from its repair`
							: `${name} was already returned`
						: `Only ${left + line.counted} of ${name} can still come back`,
				);
			}
			// What's left first; the rest was only counted back at cutover.
			const fromCutover = Math.max(0, want.quantity - left);
			const cutover =
				fromCutover > 0
					? {
							cutoverQuantity: fromCutover,
							cutoverAt: await claimCutover(tx, line.id, fromCutover),
						}
					: bench?.cutoverAt
						? { cutoverQuantity: want.quantity, cutoverAt: bench.cutoverAt }
						: {};
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
					unitCost: bench ? bench.unitCost : line.unitCost,
				}));
			} else if (restockAt !== null && line.productId !== null) {
				({ batchId } = await recordReturn(tx, {
					productId: line.productId,
					quantity: want.quantity,
					locationId: restockAt,
					reference: `return:${order.id}:${line.id}`,
					sale: sales.get(line.id) ?? null,
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
					note: input.note?.trim() || null,
					benchId: bench?.repairId ?? null,
					...cutover,
				})
				.returning({ id: orderReturns.id });
			ids.push(row.id);
			line.returned += want.quantity - fromCutover;
			line.counted -= fromCutover;
		}
		return { ids };
	});
}

// Takes returns back off, e.g. from the Undo after receiving: restocked
// units leave the shelf again. All or none: one already taken off (a second
// click, or another tab) fails the lot rather than half undoing it. A
// refurb's units can only come off while it still has them; one left empty
// that never sold is deleted from Shopify and archived, as if never made.
// One that took units off the cutover count counts them back.
// What went wrong cleaning one up comes back as problems; the undo stands.
export async function undoReturns(
	db: Db,
	ids: number[],
): Promise<{ problems: string[] }> {
	if (ids.length === 0) return { problems: [] };
	const refurbs = await db.transaction(async (tx) => {
		await readQuantityMode(tx);
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
			if (row.cutoverQuantity && row.cutoverAt)
				await restoreCutover(
					tx,
					row.orderLineId,
					row.cutoverQuantity,
					row.cutoverAt,
				);
		}
		return [...new Set(rows.flatMap((r) => r.refurbProductId ?? []))];
	});
	return retireRefurbs(db, refurbs);
}
