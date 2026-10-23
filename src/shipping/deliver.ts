import { eq, inArray } from "drizzle-orm";
import type { shopifyFulfill } from "#/channels/shopify";
import type { Db } from "#/db/client";
import { labelAttempts, shipments } from "#/db/schema";
import type { Destination } from "./destination";
import type { ebayShip } from "./ebay-handoff";
import { byLine, type PackedLine, unmappable } from "./packed";
import type { tiktokOrderUnits, tiktokShipPackage } from "./tiktok";
import { assertShippable } from "./tiktok-units";
import { storefrontTrackingUrl } from "./tracking-link";

// Telling one order's marketplace its packed box shipped, after asking the
// marketplace what it still has to ship and finding exactly the box. Each
// returns the marketplace's id for the fulfillment and how many units the
// order still has to ship after it, so katasync's own status says partly
// fulfilled rather than claiming it's all gone. A mismatch throws Held.

export type DeliverOutside = {
	shopifyFulfill: typeof shopifyFulfill;
	ebayShip: typeof ebayShip;
	tiktokUnits: typeof tiktokOrderUnits;
	tiktokShip: typeof tiktokShipPackage;
};

type Box = Omit<typeof shipments.$inferSelect, "labelPdf">;

export type Delivered = { fulfillmentId: string | null; remaining: number };

export async function deliver(
	db: Db,
	input: {
		to: Exclude<Destination, { kind: "hold" }>;
		order: { externalId: string };
		boxes: Box[];
		packed: PackedLine[];
	},
	outside: DeliverOutside,
): Promise<Delivered> {
	const { to, order, boxes, packed } = input;
	if (to.kind === "tiktok") {
		const unitIds = await unitsOf(db, boxes);
		assertShippable(
			await outside.tiktokUnits(to.orderId),
			unitIds,
			packed,
			to.relayed,
		);
		let fulfillmentId: string | null = null;
		for (const box of boxes) {
			const shipped = await outside.tiktokShip(box.externalId);
			fulfillmentId ??= shipped.id;
			if (shipped.trackingNumber && !box.trackingNumber) {
				await db
					.update(shipments)
					.set({ trackingNumber: shipped.trackingNumber })
					.where(eq(shipments.id, box.id));
			}
		}
		return { fulfillmentId, remaining: 0 };
	}
	if (boxes.some((b) => !b.trackingNumber)) {
		throw new Error("The label has no tracking number");
	}
	if (to.kind === "shopify") {
		const storefrontUrl = await storefrontTrackingUrl(order.externalId);
		return outside.shopifyFulfill(
			order.externalId,
			{
				company: boxes[0].carrier,
				boxes: boxes.map((b) => ({
					number: b.trackingNumber as string,
					url: storefrontUrl ?? b.trackingUrl,
				})),
			},
			byLine(packed),
		);
	}
	const [first] = boxes;
	return outside.ebayShip(order.externalId, byLine(packed), {
		carrier: first.carrier,
		trackingNumber: first.trackingNumber as string,
		shippedAt: first.createdAt,
	});
}

// The TikTok units a dispatch's packages were bought for, from their
// purchases.
async function unitsOf(db: Db, boxes: Box[]) {
	const rows = await db
		.select({ unitIds: labelAttempts.unitIds })
		.from(labelAttempts)
		.where(
			inArray(
				labelAttempts.shipmentId,
				boxes.map((b) => b.id),
			),
		);
	const unitIds = rows.flatMap((r) => r.unitIds ?? []);
	if (rows.length !== boxes.length || unitIds.length === 0) {
		throw unmappable(
			"Katasync has no record of which TikTok items this label covers; check it in TikTok Seller Center",
		);
	}
	return unitIds;
}
