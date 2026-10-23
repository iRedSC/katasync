import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";

// A packed shipment of these orders, as quick ship buys one now: one
// dispatch holding every order line's current quantity, a label per box,
// and each box's settled purchase (with TikTok's units for a TikTok box).
// bought: false plans one box more than was bought. Pass overrides per
// box. Returns the dispatch and its boxes' ids.
export async function addPackedDispatch(
	db: Db,
	input: {
		orderIds: number[];
		contentsKey?: string;
		bought?: boolean;
		boxes?: Partial<typeof schema.shipments.$inferInsert>[];
		unitIds?: string[];
	},
) {
	const boxes = input.boxes ?? [{}];
	return db.transaction(async (tx) => {
		const [dispatch] = await tx
			.insert(schema.dispatches)
			.values({
				contentsKey: input.contentsKey ?? "WRENCH×2",
				contents: "packed",
				boxCount: input.bought === false ? boxes.length + 1 : boxes.length,
				boughtAt: input.bought === false ? null : new Date(),
			})
			.returning();
		await tx
			.insert(schema.dispatchOrders)
			.values(
				input.orderIds.map((orderId) => ({ dispatchId: dispatch.id, orderId })),
			);
		const lines = await tx
			.select()
			.from(schema.orderLines)
			.where(
				and(
					inArray(schema.orderLines.orderId, input.orderIds),
					gt(schema.orderLines.quantity, 0),
				),
			);
		await tx.insert(schema.dispatchLines).values(
			lines.map((l) => ({
				dispatchId: dispatch.id,
				orderId: l.orderId,
				lineExternalId: l.externalId,
				productId: l.productId,
				sku: l.sku,
				title: l.title,
				quantity: l.quantity,
			})),
		);
		const saved = await tx
			.insert(schema.shipments)
			.values(
				boxes.map((box, i) => ({
					dispatchId: dispatch.id,
					lengthMm: 300,
					widthMm: 200,
					heightMm: 100,
					weightGrams: 600,
					provider: "shippo",
					carrier: "USPS",
					service: "usps_ground_advantage",
					serviceName: "USPS Ground Advantage",
					cost: 7.08,
					trackingNumber: `940010000000000000000${i}`,
					trackingUrl: "https://tools.usps.com/x",
					labelUrl: "https://example.com/label.pdf",
					externalId: `tx-${dispatch.id}-${i}-${Math.random()}`,
					test: false,
					...box,
				})),
			)
			.returning();
		await tx.insert(schema.labelAttempts).values(
			saved.map((box, i) => ({
				id: crypto.randomUUID(),
				dispatchId: dispatch.id,
				boxIndex: i,
				provider:
					box.provider === "tiktok" ? ("tiktok" as const) : ("shippo" as const),
				rateId: `rate-${i}`,
				unitIds:
					box.provider === "tiktok" ? (input.unitIds ?? ["unit-1"]) : null,
				box: {
					dispatchId: dispatch.id,
					lengthMm: box.lengthMm,
					widthMm: box.widthMm,
					heightMm: box.heightMm,
					weightGrams: box.weightGrams,
					provider: box.provider,
					carrier: box.carrier,
					service: box.service,
					serviceName: box.serviceName,
					cost: box.cost,
					test: box.test,
				},
				state: "succeeded" as const,
				shipmentId: box.id,
				settledAt: new Date(),
			})),
		);
		return { dispatchId: dispatch.id, boxIds: saved.map((b) => b.id) };
	});
}

export const holdOf = async (db: Db, dispatchId: number, orderId: number) =>
	(
		await db
			.select({ hold: schema.dispatchOrders.handoffHold })
			.from(schema.dispatchOrders)
			.where(
				and(
					eq(schema.dispatchOrders.dispatchId, dispatchId),
					eq(schema.dispatchOrders.orderId, orderId),
				),
			)
	)[0]?.hold;
