import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	dispatches,
	dispatchOrders,
	labelAttempts,
	orders,
	shipments,
} from "#/db/schema";
import { openAttempts } from "./label-attempts";

// An order's dispatches as the order page shows them.
export async function sendsOf(db: Db, orderId: number) {
	// Every dispatch this order went out in (or will): its boxes, this
	// order's tracking handoff, and any other orders in the same box.
	const handoffs = await db
		.select({
			dispatchId: dispatchOrders.dispatchId,
			channelSentAt: dispatchOrders.channelSentAt,
			channelError: dispatchOrders.channelError,
			channelRetryAt: dispatchOrders.channelRetryAt,
			hold: dispatchOrders.handoffHold,
			reversedAt: dispatchOrders.reversedAt,
			boughtAt: dispatches.boughtAt,
			boxCount: dispatches.boxCount,
			contents: dispatches.contents,
			boughtBoxes: sql<number>`(select count(*)::int from ${labelAttempts} where ${labelAttempts.dispatchId} = ${dispatches.id} and ${labelAttempts.state} = 'succeeded')`,
		})
		.from(dispatchOrders)
		.innerJoin(dispatches, eq(dispatches.id, dispatchOrders.dispatchId))
		.where(eq(dispatchOrders.orderId, orderId))
		.orderBy(dispatchOrders.dispatchId);
	const ids = handoffs.map((h) => h.dispatchId);
	const boxes = ids.length
		? await db
				.select({
					id: shipments.id,
					dispatchId: shipments.dispatchId,
					serviceName: shipments.serviceName,
					cost: shipments.cost,
					trackingNumber: shipments.trackingNumber,
					trackingUrl: shipments.trackingUrl,
					provider: shipments.provider,
					test: shipments.test,
					voidedAt: shipments.voidedAt,
					refundStatus: shipments.refundStatus,
					storefrontTrackingError: shipments.storefrontTrackingError,
					createdAt: shipments.createdAt,
				})
				.from(shipments)
				.where(inArray(shipments.dispatchId, ids))
				.orderBy(shipments.id)
		: [];
	const others = ids.length
		? await db
				.select({
					dispatchId: dispatchOrders.dispatchId,
					id: orders.id,
					name: orders.name,
				})
				.from(dispatchOrders)
				.innerJoin(orders, eq(orders.id, dispatchOrders.orderId))
				.where(
					and(
						inArray(dispatchOrders.dispatchId, ids),
						ne(dispatchOrders.orderId, orderId),
					),
				)
				.orderBy(orders.id)
		: [];
	const unsettled = await openAttempts(db, ids);
	// A purchase whose first box failed leaves a dispatch with no boxes;
	// there's nothing to show for it, unless a purchase is still unsettled.
	const sends = handoffs.flatMap((h) => {
		const own = boxes.filter((b) => b.dispatchId === h.dispatchId);
		const attempts = unsettled.filter((a) => a.dispatchId === h.dispatchId);
		if (own.length === 0 && attempts.length === 0) return [];
		return {
			id: h.dispatchId,
			channelSentAt: h.channelSentAt,
			channelError: h.channelError,
			hold: h.channelSentAt
				? null
				: (h.hold ??
					(h.contents === "unknown"
						? ({ kind: "unknownContents" } as const)
						: null)),
			attempts,
			// Still being sent again on its own (src/shipping/retry.ts).
			retrying: h.channelRetryAt !== null,
			// False when a box failed part way: void only, never send. Every
			// planned box bought counts too: sending finishes marking it.
			complete: h.boughtAt !== null || h.boughtBoxes === h.boxCount,
			// Voided, but taking it back for this order didn't finish.
			unfinishedVoid: h.reversedAt === null,
			boxes: own,
			live: own.some((b) => b.voidedAt === null),
			shippedWith: others.filter((o) => o.dispatchId === h.dispatchId),
		};
	});
	return sends;
}
