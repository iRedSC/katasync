import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import {
	shopifyCancelFulfillment,
	shopifyFulfill,
	shopifyRemoveShippoTracking,
	shopifySaveShippoTracking,
} from "#/channels/shopify";
import type { Db } from "#/db/client";
import { dispatchOrders, orders, shipments } from "#/db/schema";
import { readQuantityMode } from "#/inventory/commitments";
import {
	assertFulfillmentRestorable,
	restoreCommitments,
} from "#/inventory/commitments-restore";
import { lockOnOwnConnection, type OrderLocker, ordersOf } from "./dispatch";
import { ebayShip } from "./ebay-handoff";
import {
	type Box,
	boxColumns,
	load,
	type Member,
	sameMember,
} from "./handoff/members";
import { blockerOfSharedPackage, done, type Told, tell } from "./handoff/tell";
import { completeIfAllBought } from "./label-attempts";
import { contentsOf } from "./packed";
import { assignOrderPins } from "./pins";
import { refundLabel } from "./shippo";
import { tiktokOrderUnits, tiktokShipPackage } from "./tiktok";

// The outside calls, passed in so tests can stand in for Shopify, eBay, and
// Shippo.
export type Outside = {
	lock: OrderLocker;
	shopifyFulfill: typeof shopifyFulfill;
	shopifyCancel: typeof shopifyCancelFulfillment;
	shopifySaveTracking: typeof shopifySaveShippoTracking;
	shopifyRemoveTracking: typeof shopifyRemoveShippoTracking;
	ebayShip: typeof ebayShip;
	refund: typeof refundLabel;
	tiktokShip: typeof tiktokShipPackage;
	tiktokUnits: typeof tiktokOrderUnits;
};

export const live: Outside = {
	lock: lockOnOwnConnection,
	shopifyFulfill,
	shopifyCancel: shopifyCancelFulfillment,
	shopifySaveTracking: shopifySaveShippoTracking,
	shopifyRemoveTracking: shopifyRemoveShippoTracking,
	ebayShip,
	refund: refundLabel,
	tiktokShip: tiktokShipPackage,
	tiktokUnits: tiktokOrderUnits,
};

export type Handoff = { sent: boolean; message: string };

// Tells each order's marketplace it shipped, with every box's tracking, so
// the customer hears about it and the order leaves To ship. Orders in one
// dispatch are told one by one: a refusal is recorded on that order and
// shown with a retry, never undoes the labels, and doesn't stop the others.
// Retrying is safe: orders already told are skipped, and the marketplace
// calls return the earlier fulfillment if one got through.
export async function sendTracking(
	db: Db,
	dispatchId: number,
	outside: Outside = live,
): Promise<Handoff> {
	const outcome = await outside.lock(
		await ordersOf(db, dispatchId),
		async () => {
			const { dispatch, boxes, members } = await load(db, dispatchId);
			const liveBoxes = boxes.filter((b) => !b.voidedAt);
			if (liveBoxes.length === 0) throw new Error("This label was voided");
			// Telling a marketplace it shipped with only some of its boxes
			// would be wrong; such a shipment can only be voided.
			if (!dispatch.boughtAt && !(await completeIfAllBought(db, dispatchId))) {
				throw new Error(
					"Not every box in this shipment was bought. Void it and ship again.",
				);
			}
			if (liveBoxes.length < boxes.length) {
				throw new Error(
					"Some labels in this shipment were voided. Void the rest and ship again.",
				);
			}
			const contents = await contentsOf(db, dispatchId);
			const label = (m: Member, message: string) =>
				members.length > 1 ? `${m.order.name}: ${message}` : message;
			if (
				members.length > 1 &&
				liveBoxes.every((b) => b.provider === "tiktok")
			) {
				const blocker = await blockerOfSharedPackage(
					db,
					members,
					liveBoxes,
					contents,
					outside,
				);
				if (blocker) {
					return members.map((m) =>
						m === blocker.member
							? { ...blocker.result, message: label(m, blocker.result.message) }
							: done(
									m.handoff.channelSentAt !== null,
									label(
										m,
										`waits on ${blocker.member.order.name}, which shares its TikTok package`,
									),
								),
					);
				}
			}
			const results: Told[] = [];
			for (const member of members) {
				const result = await tell(db, member, liveBoxes, contents, outside);
				// With several orders, each message says which one it's about.
				results.push(
					members.length > 1
						? { ...result, message: `${member.order.name}: ${result.message}` }
						: result,
				);
			}
			return results;
		},
	);
	// Frees the shipped orders' pins (or none, if nothing changed).
	if (outcome.some((r) => r.newly)) await assignOrderPins(db);
	const notes = outcome.some((result) => result.sent)
		? await storefrontNotes(db, dispatchId, outside)
		: [];
	return {
		sent: outcome.every((r) => r.sent),
		message: [...outcome.map((r) => r.message), ...notes].join(". "),
	};
}

// remaining: labels still live because their refund was refused; voiding
// again retries them.
export type Voided = {
	refundStatus: string;
	notes: string[];
	remaining: number;
};

// Voids a dispatch: asks for every box's postage back, takes the tracking
// back off each order's marketplace where it can, and returns the orders to
// To ship. Each box is refunded on its own: a refused refund leaves that box
// (and so the dispatch) live, keeps the boxes already refunded voided, and
// voiding again retries just what's left. The orders only go back once
// every box is voided. Each order's reversal is recorded when it finishes,
// so a void that stopped part way (or a Shopify cancel that failed) is
// finished by voiding again.
export async function voidDispatch(
	db: Db,
	dispatchId: number,
	outside: Outside = live,
): Promise<Voided> {
	const result = await outside.lock(
		await ordersOf(db, dispatchId),
		async () => {
			const { boxes, members } = await load(db, dispatchId);
			const liveBoxes = boxes.filter((b) => !b.voidedAt);
			const pending = members.filter((m) => !m.handoff.reversedAt);
			for (const member of pending) {
				await assertFulfillmentRestorable(db, {
					orderId: member.order.id,
					fulfillmentKey: `dispatch:${dispatchId}:order:${member.order.id}`,
				});
			}
			if (liveBoxes.length === 0 && pending.length === 0) {
				throw new Error("This label is already voided");
			}
			if (liveBoxes.some((b) => b.provider === "tiktok")) {
				throw new Error(
					"TikTok labels can't be voided from katasync; cancel it in TikTok Seller Center",
				);
			}

			const statuses: string[] = [];
			const notes: string[] = [];
			for (const [i, box] of liveBoxes.entries()) {
				try {
					const { status } = await outside.refund(box.externalId);
					statuses.push(status);
					await db
						.update(shipments)
						.set({ voidedAt: new Date(), refundStatus: status })
						.where(eq(shipments.id, box.id));
				} catch (err) {
					// Nothing refunded this time: nothing changed, so just say why.
					if (i === 0) throw err;
					const why = err instanceof Error ? err.message : String(err);
					notes.push(
						`${liveBoxes.length - i} of ${liveBoxes.length} labels weren't refunded (${why}); they're still live. Void again to retry.`,
					);
					return {
						refundStatus: summary(statuses),
						notes,
						remaining: liveBoxes.length - i,
					};
				}
			}

			for (const member of pending) {
				const { order, channel, handoff } = member;
				// Whether the marketplace now agrees the order isn't shipped.
				let backToShip = !handoff.channelSentAt;
				const label = members.length > 1 ? `${order.name}: ` : "";
				if (handoff.channelSentAt && channel === "shopify") {
					try {
						if (!handoff.channelFulfillmentId) {
							throw new Error("no fulfillment id saved");
						}
						await outside.shopifyCancel(handoff.channelFulfillmentId);
						notes.push(`${label}Shopify shows the order unshipped again`);
						backToShip = true;
					} catch (err) {
						const why = err instanceof Error ? err.message : String(err);
						notes.push(
							`${label}Shopify still shows it shipped (${why}). Void again to retry, or cancel the fulfillment in Shopify.`,
						);
					}
				}
				if (handoff.channelSentAt && channel === "ebay") {
					notes.push(
						`${label}eBay keeps the old tracking number; it can't be removed from here. Correct it in Seller Hub if this order isn't reshipped.`,
					);
					backToShip = true;
				}
				if (!backToShip) continue;
				let putBack = false;
				// One live dispatch per order, so voiding it means nothing has
				// shipped. Recorded together with the order going back.
				await db.transaction(async (tx) => {
					await readQuantityMode(tx);
					const [newer] = await tx
						.select({ dispatchId: dispatchOrders.dispatchId })
						.from(dispatchOrders)
						.where(
							and(
								eq(dispatchOrders.orderId, order.id),
								gt(dispatchOrders.dispatchId, dispatchId),
								isNotNull(dispatchOrders.channelSentAt),
								isNull(dispatchOrders.reversedAt),
							),
						)
						.limit(1);
					putBack =
						handoff.channelSentAt !== null &&
						!newer &&
						order.fulfillmentStatus === "FULFILLED";
					if (putBack) {
						await tx
							.update(orders)
							.set({ fulfillmentStatus: "UNFULFILLED" })
							.where(eq(orders.id, order.id));
					}
					if (handoff.channelSentAt !== null && !newer)
						await restoreCommitments(tx, {
							orderId: order.id,
							fulfillmentKey: `dispatch:${dispatchId}:order:${order.id}`,
						});
					await tx
						.update(dispatchOrders)
						.set({ reversedAt: new Date() })
						.where(sameMember(member));
				});
				if (putBack) {
					notes.push(`${label}The order is back on To ship`);
				}
			}
			return { refundStatus: summary(statuses), notes, remaining: 0 };
		},
	);
	await assignOrderPins(db);
	result.notes.push(...(await storefrontNotes(db, dispatchId, outside)));
	return result;
}

// Brings one box's storefront tracking up to date.
async function updateStorefrontTracking(
	db: Db,
	shipmentId: number,
	outside: Outside,
): Promise<string | null> {
	const [shipment] = await db
		.select(boxColumns)
		.from(shipments)
		.where(eq(shipments.id, shipmentId));
	if (!shipment) throw new Error(`No shipment ${shipmentId}`);
	return outside.lock(await ordersOf(db, shipment.dispatchId), async () => {
		const { boxes, members } = await load(db, shipment.dispatchId);
		const box = boxes.find((candidate) => candidate.id === shipmentId);
		return box ? storefrontNote(db, box, members, outside) : null;
	});
}

// Brings every box's storefront tracking up to date, from one read of the
// dispatch under one lock. Each box keeps its own outcome.
async function storefrontNotes(db: Db, dispatchId: number, outside: Outside) {
	return outside.lock(await ordersOf(db, dispatchId), async () => {
		const { boxes, members } = await load(db, dispatchId);
		const notes: string[] = [];
		for (const box of boxes) {
			const note = await storefrontNote(db, box, members, outside);
			if (note) notes.push(note);
		}
		return notes;
	});
}

// One box's storefront tracking, on each of its orders' Shopify. Its outcome
// is saved on the box.
async function storefrontNote(
	db: Db,
	box: Box,
	members: Member[],
	outside: Outside,
): Promise<string | null> {
	if (!box.carrierToken || !box.trackingNumber || box.test) return null;
	const entry = {
		number: box.trackingNumber,
		carrier: box.carrierToken,
		url: box.trackingUrl,
	};
	const notes: string[] = [];
	for (const { order, channel, handoff } of members) {
		if (channel !== "shopify" || (!box.voidedAt && !handoff.channelSentAt))
			continue;
		try {
			if (box.voidedAt)
				await outside.shopifyRemoveTracking(order.externalId, entry.number);
			else await outside.shopifySaveTracking(order.externalId, entry);
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			const fix = box.voidedAt
				? `Remove tracking ${entry.number} from`
				: `Add ${JSON.stringify(entry)} to`;
			console.error(
				`STOREFRONT TRACKING NOT UPDATED for ${order.externalId}: ${fix} katasync.shippo_tracking.`,
				error,
			);
			notes.push(
				`${order.name}: The storefront's tracking page isn't up to date (${why}). ${fix} the order's katasync.shippo_tracking metafield in Shopify.`,
			);
		}
	}
	const note = notes.length > 0 ? notes.join(". ") : null;
	await db
		.update(shipments)
		.set({ storefrontTrackingError: note })
		.where(eq(shipments.id, box.id));
	return note;
}

export async function retryStorefrontTracking(
	db: Db,
	shipmentId: number,
	outside: Outside = live,
): Promise<Handoff> {
	const [shipment] = await db
		.select(boxColumns)
		.from(shipments)
		.where(eq(shipments.id, shipmentId));
	if (!shipment || !shipment.carrierToken || !shipment.trackingNumber)
		throw new Error("This label has nothing for the storefront");
	const note = await updateStorefrontTracking(db, shipmentId, outside);
	return note
		? { sent: false, message: note }
		: { sent: true, message: "Storefront tracking up to date" };
}

// One word for several boxes' refunds when they agree, else each.
const summary = (statuses: string[]) => [...new Set(statuses)].join(", ");
