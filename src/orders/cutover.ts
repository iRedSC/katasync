import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orderReturns } from "#/db/schema";

// Units counted back at cutover (order_returns.pre_cutover) are only
// assumed back: the box may still be waiting to be opened. Checking one in
// or benching it takes it off the assumption, and whatever took it keeps
// when it was counted, so undoing that counts it back as it was. Run
// holding the order, as receiving does. Server only.

// How many of a line's units are counted back at cutover.
export const countedAtCutover = sql<number>`coalesce((
	select sum(c.quantity) from ${orderReturns} c
	where c.order_line_id = "order_lines"."id" and c.pre_cutover
), 0)::int`;

export class CutoverError extends Error {
	name = "CutoverError";
}

// Takes quantity units off a line's cutover count, oldest first, and says
// when the first of them was counted.
export async function claimCutover(
	tx: Db,
	lineId: number,
	quantity: number,
): Promise<Date> {
	const rows = await tx
		.select()
		.from(orderReturns)
		.where(
			and(
				eq(orderReturns.orderLineId, lineId),
				eq(orderReturns.preCutover, true),
			),
		)
		.orderBy(asc(orderReturns.createdAt), asc(orderReturns.id))
		.for("update");
	let wanted = quantity;
	for (const row of rows) {
		if (wanted === 0) break;
		const take = Math.min(wanted, row.quantity);
		if (take === row.quantity)
			await tx.delete(orderReturns).where(eq(orderReturns.id, row.id));
		else
			await tx
				.update(orderReturns)
				.set({ quantity: row.quantity - take })
				.where(eq(orderReturns.id, row.id));
		wanted -= take;
	}
	if (wanted > 0 || rows.length === 0)
		throw new CutoverError("Those units aren't counted back any more");
	return rows[0].createdAt;
}

// Counts units back at cutover again, as they were.
export async function restoreCutover(
	tx: Db,
	lineId: number,
	quantity: number,
	at: Date,
) {
	await tx.insert(orderReturns).values({
		orderLineId: lineId,
		quantity,
		restocked: false,
		preCutover: true,
		createdAt: at,
	});
}
