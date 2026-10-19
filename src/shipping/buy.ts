import { eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { dispatches, dispatchOrders, packages, shipments } from "#/db/schema";
import { labelSource } from "#/orders/fulfillment";
import { shipAddresses } from "./addresses";
import {
	assertTogether,
	lockOnOwnConnection,
	type OrderLocker,
} from "./dispatch";
import { signatureRequired } from "./quick-ship";
import {
	buyLabel,
	getRate,
	getRates,
	refundLabel,
	shippoIsTest,
} from "./shippo";
import { tiktokBuyLabel, tiktokOrderId } from "./tiktok";

// The outside calls, passed in so tests can stand in for Shippo, TikTok,
// and the order locks.
export type BuyOutside = {
	lock: OrderLocker;
	getRates: typeof getRates;
	getRate: typeof getRate;
	buyLabel: typeof buyLabel;
	refund: typeof refundLabel;
	tiktokBuy: typeof tiktokBuyLabel;
	isTest: () => boolean;
};

export const liveBuy: BuyOutside = {
	lock: lockOnOwnConnection,
	getRates,
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
	// Aerosols inside: ground services only, and the label prints with the
	// Limited Quantity mark (see hazmat.ts).
	hazmat: boolean;
};

// The service picked in quick ship. Only which service: the price and the
// rate bought are the seller's, quoted again here for these exact orders and
// boxes. `id` is TikTok's service id (TikTok quotes by order itself).
export type ServiceChoice = { carrier: string; service: string; id: string };

// Most boxes one send could need; more is almost surely a mistake.
export const MAX_BOXES = 10;

type Shipment = typeof shipments.$inferSelect;

export type Bought = {
	dispatchId: number;
	boxes: Shipment[];
	// Why the purchase stopped part way, with what was bought refunded.
	failed: string | null;
};

// Buys one label per box for these orders, all with one service, as one
// dispatch. The orders' locks are held throughout, and none may already
// have a live dispatch, so a double press or two people can't buy twice.
//
// Each box is priced again here from the orders' own address and the box's
// own size, so a stale or mismatched quote from the browser can't be bought.
// Each label is recorded the moment it's paid for, and the records commit as
// they go (see lockOnOwnConnection), so nothing paid for can be rolled back.
// If a later box fails, the ones already bought are refunded and the
// failure is returned; the dispatch never counts as bought, so it can't
// send tracking, only be voided.
export async function buyDispatch(
	db: Db,
	input: {
		orderIds: number[];
		contentsKey: string;
		boxes: BoxPlan[];
		choice: ServiceChoice;
		// Asked for in quick ship. Orders that need one get one regardless.
		signature: boolean;
	},
	outside: BuyOutside = liveBuy,
): Promise<Bought> {
	const { boxes, choice } = input;
	if (boxes.length === 0) throw new Error("No boxes to ship");
	if (boxes.length > MAX_BOXES) {
		throw new Error(`At most ${MAX_BOXES} boxes in one shipment`);
	}
	return outside.lock(input.orderIds, async () => {
		const list = await assertTogether(db, input.orderIds);
		const tiktok = labelSource(list[0]) === "tiktok";
		// TikTok sells one label per order package; combining or splitting
		// happens in Seller Center.
		if (tiktok && (list.length > 1 || boxes.length > 1)) {
			throw new Error(
				"TikTok: one order per box. Combine or split in TikTok Seller Center.",
			);
		}
		// Anything that could stop a record being saved is checked before
		// money is spent.
		await assertBoxesExist(db, boxes);
		const signature =
			!tiktok && (input.signature || signatureRequired(list) !== null);
		const rates = tiktok
			? []
			: await quoteEach(db, list[0].id, boxes, choice, signature, outside);

		const dispatchId = await db.transaction(async (tx) => {
			const [dispatch] = await tx
				.insert(dispatches)
				.values({ contentsKey: input.contentsKey })
				.returning();
			await tx
				.insert(dispatchOrders)
				.values(list.map((o) => ({ dispatchId: dispatch.id, orderId: o.id })));
			return dispatch.id;
		});

		const bought: Shipment[] = [];
		for (const [i, plan] of boxes.entries()) {
			const box = {
				dispatchId,
				packageId: plan.packageId,
				lengthMm: plan.lengthMm,
				widthMm: plan.widthMm,
				heightMm: plan.heightMm,
				weightGrams: plan.weightGrams,
				hazmat: plan.hazmat,
			};
			let row: typeof shipments.$inferInsert;
			try {
				if (tiktok) {
					// A package TikTok already made for this order is recorded,
					// not bought again (a retry after a lost response).
					const label = await outside.tiktokBuy(
						tiktokOrderId(list[0].marketplaceOrderId),
						plan,
						choice.id,
					);
					row = {
						...box,
						provider: "tiktok",
						carrier: label.rate.carrier,
						service: label.rate.service,
						serviceName: label.rate.serviceName,
						cost: label.rate.cost,
						insuredAmount: null,
						signature: false,
						trackingNumber: null,
						trackingUrl: null,
						// TikTok's links expire; label-file.ts fetches by package.
						labelUrl: null,
						externalId: label.packageId,
						test: false,
					};
				} else {
					const rate = rates[i];
					const label = await outside.buyLabel(rate.id);
					row = {
						...box,
						provider: "shippo",
						carrier: rate.carrier,
						carrierToken: rate.carrierToken ?? null,
						service: rate.service,
						serviceName: rate.serviceName,
						cost: rate.cost,
						insuredAmount: plan.insureAmount,
						signature,
						trackingNumber: label.trackingNumber,
						trackingUrl: label.trackingUrl,
						labelUrl: label.labelUrl,
						externalId: label.id,
						test: outside.isTest(),
					};
				}
				bought.push(await record(db, row, outside));
			} catch (err) {
				// Nothing bought yet: nothing to keep, so the empty dispatch
				// stays behind unused (it never counts as live).
				if (bought.length === 0) throw err;
				const why = err instanceof Error ? err.message : String(err);
				const after = await refundAll(db, bought, outside);
				const stillLive = after.filter((b) => !b.voidedAt).length;
				if (stillLive === 0) {
					await db
						.update(dispatchOrders)
						.set({ reversedAt: new Date() })
						.where(eq(dispatchOrders.dispatchId, dispatchId));
				}
				return {
					dispatchId,
					boxes: after,
					failed: `Box ${i + 1} of ${boxes.length} wasn't bought (${why}). ${
						stillLive === 0
							? "The labels already bought were refunded; press again to retry."
							: `${stillLive} label${stillLive === 1 ? "" : "s"} already bought couldn't be refunded; void ${stillLive === 1 ? "it" : "them"} on the order page.`
					}`,
				};
			}
		}
		await db
			.update(dispatches)
			.set({ boughtAt: new Date() })
			.where(eq(dispatches.id, dispatchId));
		return { dispatchId, boxes: bought, failed: null };
	});
}

async function assertBoxesExist(db: Db, boxes: BoxPlan[]) {
	const ids = [
		...new Set(
			boxes.flatMap((b) => (b.packageId === null ? [] : [b.packageId])),
		),
	];
	if (ids.length === 0) return;
	const found = await db
		.select({ id: packages.id })
		.from(packages)
		.where(inArray(packages.id, ids));
	if (found.length !== ids.length) {
		throw new Error("A box was deleted from Settings; choose it again");
	}
}

// Prices every box again from the orders' address and picks the chosen
// service for each; the cheapest if the carrier offers it twice.
async function quoteEach(
	db: Db,
	orderId: number,
	boxes: BoxPlan[],
	choice: ServiceChoice,
	signature: boolean,
	outside: BuyOutside,
): Promise<Awaited<ReturnType<typeof getRate>>[]> {
	const where = await shipAddresses(db, orderId);
	const quoted = await Promise.all(
		boxes.map((b) =>
			outside.getRates({
				...where,
				parcel: b,
				insureAmount: b.insureAmount,
				signature,
				hazmat: b.hazmat,
			}),
		),
	);
	return Promise.all(
		quoted.map(async ({ rates }, i) => {
			const [rate] = rates
				.filter(
					(r) => r.carrier === choice.carrier && r.service === choice.service,
				)
				.sort((a, b) => a.cost - b.cost);
			if (!rate) {
				throw new Error(
					`${choice.carrier} no longer offers that service${boxes.length > 1 ? ` for box ${i + 1}` : ""}; price again`,
				);
			}
			const confirmed = await outside.getRate(rate.id);
			if (
				confirmed.carrier !== choice.carrier ||
				confirmed.service !== choice.service
			) {
				throw new Error("The quoted service changed; price again");
			}
			return confirmed;
		}),
	);
}

// Saves a bought label. If saving fails, the label is refunded so no money
// is spent on a label katasync doesn't know about, and the error goes on.
async function record(
	db: Db,
	row: typeof shipments.$inferInsert,
	outside: BuyOutside,
): Promise<Shipment> {
	try {
		const [saved] = await db.insert(shipments).values(row).returning();
		return saved;
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		const byHand = `cancel ${row.provider} label ${row.externalId} by hand`;
		// TikTok labels can't be cancelled from here (see voidDispatch).
		const refunded =
			row.provider === "shippo"
				? await outside
						.refund(row.externalId)
						.then(() => "it was refunded")
						.catch(() => byHand)
				: byHand;
		throw new Error(
			`A label was bought but couldn't be saved (${why}); ${refunded}`,
		);
	}
}

// Refunds the boxes of a purchase that stopped part way, recording each
// refund as it's granted. A refund the provider refuses leaves that box
// live, to be voided from the order page.
async function refundAll(db: Db, boxes: Shipment[], outside: BuyOutside) {
	const after: Shipment[] = [];
	for (const box of boxes) {
		try {
			const { status } = await outside.refund(box.externalId);
			const [voided] = await db
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
