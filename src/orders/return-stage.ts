import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orderLines, orderReturns, orderReturnsDue } from "#/db/schema";
import type { ReturnStage } from "./status";

// Where each order's return stands, for its status badge: returning while
// one is requested, on its way, or refunded and expected back (not a mere
// maybe), and returned once something came back and nothing more is due.
// Orders with no return are left out. Server only.
export async function returnStages(
	db: Db,
	orderIds: number[],
): Promise<Map<number, Exclude<ReturnStage, null>>> {
	if (orderIds.length === 0) return new Map();
	const [due, received] = await Promise.all([
		db
			.selectDistinct({ orderId: orderReturnsDue.orderId })
			.from(orderReturnsDue)
			.where(
				and(
					inArray(orderReturnsDue.orderId, orderIds),
					ne(orderReturnsDue.state, "maybe"),
				),
			),
		db
			.selectDistinct({ orderId: orderLines.orderId })
			.from(orderReturns)
			.innerJoin(orderLines, eq(orderLines.id, orderReturns.orderLineId))
			.where(inArray(orderLines.orderId, orderIds)),
	]);
	const stages = new Map<number, Exclude<ReturnStage, null>>();
	for (const r of received) stages.set(r.orderId, "returned");
	for (const d of due) stages.set(d.orderId, "returning");
	return stages;
}
