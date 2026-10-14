import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { dispatches, dispatchOrders, shipments } from "#/db/schema";
import { labelSource } from "#/orders/fulfillment";
import { assertTogether, withOrderLocks } from "./dispatch";
import { buyLabel, getRate, refundLabel, shippoIsTest } from "./shippo";
import { tiktokBuyLabel, tiktokOrderId } from "./tiktok";

// The outside calls, passed in so tests can stand in for Shippo and TikTok.
export type BuyOutside = {
	getRate: typeof getRate;
	buyLabel: typeof buyLabel;
	refund: typeof refundLabel;
	tiktokBuy: typeof tiktokBuyLabel;
	isTest: () => boolean;
};

export const liveBuy: BuyOutside = {
	getRate,
	buyLabel,
	refund: refundLabel,
	tiktokBuy: tiktokBuyLabel,
	isTest: shippoIsTest,
};

export type BoxPlan = {
	packageId: number | null;
	lengthMm: number;
	widthMm: number;
	heightMm: number;
	weightGrams: number;
	insureAmount: number | null;
	// The chosen service's rate for this box (TikTok: the service id).
	rateId: string;
};

// Most boxes one send could need; more is almost surely a mistake.
export const MAX_BOXES = 10;

export type Bought = {
	dispatchId: number;
	boxes: (typeof shipments.$inferSelect)[];
	// Why the purchase stopped part way, with what was bought refunded.
	failed: string | null;
};

// Buys one label per box for these orders, all with one service, as one
// dispatch. Rates are read back from the seller, so recorded costs and
// services are theirs, not the browser's. The orders' locks are held
// throughout, and none may already have a live dispatch, so a double press
// or two people can't buy twice.
//
// Labels are bought one at a time and each is recorded as soon as it's paid
// for. If a later box fails, the boxes already bought are refunded and kept
// as voided, and the failure is returned rather than thrown so those records
// survive; nothing stays live, so pressing again starts clean.
export async function buyDispatch(
	db: Db,
	input: { orderIds: number[]; contentsKey: string; boxes: BoxPlan[] },
	outside: BuyOutside = liveBuy,
): Promise<Bought> {
	if (input.boxes.length === 0) throw new Error("No boxes to ship");
	if (input.boxes.length > MAX_BOXES) {
		throw new Error(`At most ${MAX_BOXES} boxes in one shipment`);
	}
	return withOrderLocks(db, input.orderIds, async (tx) => {
		const list = await assertTogether(tx, input.orderIds);
		const tiktok = labelSource(list[0]) === "tiktok";
		// TikTok sells one label per order package; combining or splitting
		// happens in Seller Center.
		if (tiktok && (list.length > 1 || input.boxes.length > 1)) {
			throw new Error(
				"TikTok orders ship one order to one box on TikTok's label. Combine or split TikTok packages in TikTok Seller Center.",
			);
		}
		// Every box goes out with the same service, priced before anything is
		// bought.
		const rates = tiktok
			? []
			: await Promise.all(input.boxes.map((b) => outside.getRate(b.rateId)));
		if (new Set(rates.map((r) => `${r.carrier}|${r.service}`)).size > 1) {
			throw new Error("Every box must ship with the same service");
		}

		const [dispatch] = await tx
			.insert(dispatches)
			.values({ contentsKey: input.contentsKey })
			.returning();
		await tx
			.insert(dispatchOrders)
			.values(list.map((o) => ({ dispatchId: dispatch.id, orderId: o.id })));

		const bought: (typeof shipments.$inferSelect)[] = [];
		for (const [i, plan] of input.boxes.entries()) {
			const box = {
				dispatchId: dispatch.id,
				packageId: plan.packageId,
				lengthMm: plan.lengthMm,
				widthMm: plan.widthMm,
				heightMm: plan.heightMm,
				weightGrams: plan.weightGrams,
			};
			let row: typeof shipments.$inferInsert;
			try {
				if (tiktok) {
					// A package TikTok already made for this order is recorded,
					// not bought again (a retry after a lost response).
					const label = await outside.tiktokBuy(
						tiktokOrderId(list[0].marketplaceOrderId),
						plan,
						plan.rateId,
					);
					row = {
						...box,
						provider: "tiktok",
						carrier: label.rate.carrier,
						service: label.rate.service,
						serviceName: label.rate.serviceName,
						cost: label.rate.cost,
						insuredAmount: null,
						trackingNumber: null,
						trackingUrl: null,
						// TikTok's links expire; label-file.ts fetches by package.
						labelUrl: null,
						externalId: label.packageId,
						test: false,
					};
				} else {
					const rate = rates[i];
					const label = await outside.buyLabel(plan.rateId);
					row = {
						...box,
						provider: "shippo",
						carrier: rate.carrier,
						service: rate.service,
						serviceName: rate.serviceName,
						cost: rate.cost,
						insuredAmount: plan.insureAmount,
						trackingNumber: label.trackingNumber,
						trackingUrl: label.trackingUrl,
						labelUrl: label.labelUrl,
						externalId: label.id,
						test: outside.isTest(),
					};
				}
			} catch (err) {
				// Nothing bought yet: nothing to keep, so the dispatch rolls back.
				if (bought.length === 0) throw err;
				const why = err instanceof Error ? err.message : String(err);
				const after = await refundAll(tx, bought, outside);
				const stillLive = after.filter((b) => !b.voidedAt).length;
				return {
					dispatchId: dispatch.id,
					boxes: after,
					failed: `Box ${i + 1} of ${input.boxes.length} wasn't bought (${why}). ${
						stillLive === 0
							? "The labels already bought were refunded; press again to retry."
							: `${stillLive} label${stillLive === 1 ? "" : "s"} already bought couldn't be refunded; void ${stillLive === 1 ? "it" : "them"} on the order page.`
					}`,
				};
			}
			const [saved] = await tx.insert(shipments).values(row).returning();
			bought.push(saved);
		}
		return { dispatchId: dispatch.id, boxes: bought, failed: null };
	});
}

// Refunds the boxes of a purchase that stopped part way. A refund the
// provider refuses leaves that box live, to be voided from the order page.
async function refundAll(
	tx: Db,
	boxes: (typeof shipments.$inferSelect)[],
	outside: BuyOutside,
) {
	const after: (typeof shipments.$inferSelect)[] = [];
	for (const box of boxes) {
		try {
			const { status } = await outside.refund(box.externalId);
			const [voided] = await tx
				.update(shipments)
				.set({ voidedAt: new Date(), refundStatus: status })
				.where(eq(shipments.id, box.id))
				.returning();
			after.push(voided);
		} catch {
			after.push(box);
		}
	}
	return after;
}
