import { and, eq, getTableColumns, gt, isNotNull, isNull } from "drizzle-orm";
import {
	shopifyCancelFulfillment,
	shopifyFulfill,
	shopifyRemoveShippoTracking,
	shopifySaveShippoTracking,
} from "#/channels/shopify";
import type { Db } from "#/db/client";
import {
	dispatches,
	dispatchOrders,
	type HandoffHold,
	orders,
	shipments,
	stores,
} from "#/db/schema";
import { readQuantityMode } from "#/inventory/commitments";
import { consumeCommitments } from "#/inventory/commitments-consume";
import {
	assertFulfillmentRestorable,
	restoreCommitments,
} from "#/inventory/commitments-restore";
import { deliver } from "./deliver";
import { destinationOf } from "./destination";
import { lockOnOwnConnection, type OrderLocker, ordersOf } from "./dispatch";
import { ebayShip } from "./ebay-handoff";
import { completeIfAllBought } from "./label-attempts";
import { type Contents, contentsOf, Held, packedOf } from "./packed";
import { assignOrderPins } from "./pins";
import { nextRetry } from "./retry-window";
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

// The channels katasync sends tracking to, by the name people use.
const trackingChannels: Record<string, string> = {
	shopify: "Shopify",
	ebay: "eBay",
	tiktok: "TikTok",
};

// A box's columns but its label PDF: nothing here needs the PDF, and reading
// it for every box of a dispatch was the slow part.
const { labelPdf: _labelPdf, ...boxColumns } = getTableColumns(shipments);
type Box = Omit<typeof shipments.$inferSelect, "labelPdf">;

async function load(db: Db, dispatchId: number) {
	const [dispatch] = await db
		.select()
		.from(dispatches)
		.where(eq(dispatches.id, dispatchId));
	const boxes = await db
		.select(boxColumns)
		.from(shipments)
		.where(eq(shipments.dispatchId, dispatchId))
		.orderBy(shipments.id);
	const members = await db
		.select({
			handoff: dispatchOrders,
			order: {
				id: orders.id,
				name: orders.name,
				externalId: orders.externalId,
				fulfillmentStatus: orders.fulfillmentStatus,
				cancelledAt: orders.cancelledAt,
				financialStatus: orders.financialStatus,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
				shipCountry: orders.shipCountry,
			},
			channel: stores.channel,
		})
		.from(dispatchOrders)
		.innerJoin(orders, eq(orders.id, dispatchOrders.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(eq(dispatchOrders.dispatchId, dispatchId))
		.orderBy(orders.id);
	if (!dispatch || boxes.length === 0 || members.length === 0) {
		throw new Error(`No dispatch ${dispatchId}`);
	}
	return { dispatch, boxes, members };
}

type Member = Awaited<ReturnType<typeof load>>["members"][number];

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
			const results: (Handoff & { newly: boolean })[] = [];
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

// Tells one order's marketplace, once the marketplace itself shows exactly
// what was packed still to ship (see deliver.ts). A dispatch bought before
// contents were kept, a label that doesn't fit where the order was sold, or
// any mismatch is held for a person instead.
async function tell(
	db: Db,
	member: Member,
	boxes: Box[],
	contents: Contents,
	outside: Outside,
): Promise<Handoff & { newly: boolean }> {
	const { order, channel, handoff } = member;
	const to = destinationOf(
		{ ...order, channel },
		boxes.map((b) => b.provider),
	);
	const name =
		to.kind === "hold"
			? (trackingChannels[channel] ?? channel)
			: trackingChannels[to.kind];
	const done = (sent: boolean, message: string, newly = false) => ({
		sent,
		message,
		newly,
	});
	if (handoff.channelSentAt) {
		return done(true, `Tracking already sent to ${name}`);
	}
	// Telling the customer it shipped would be wrong; the box stays here.
	if (order.cancelledAt) {
		return done(false, "The order was cancelled; void the label instead");
	}
	if (
		order.financialStatus === "REFUNDED" ||
		order.financialStatus === "VOIDED"
	) {
		return done(
			false,
			"The order was refunded or voided; void the label instead",
		);
	}
	// A test label's tracking number is fake; customers must never get it.
	if (boxes.some((b) => b.test)) {
		return done(false, `Test label, so ${name} wasn't told`);
	}
	const hold = async (held: HandoffHold, why: string) => {
		await db
			.update(dispatchOrders)
			.set({ channelError: why, handoffHold: held, channelRetryAt: null })
			.where(sameMember(member));
		return done(false, `Not sent to ${name}: ${why}`);
	};
	if (contents.kind === "unknown") {
		return hold(
			{ kind: "unknownContents" },
			`bought before katasync kept what was packed, so it can't check the box against the order. Tell ${name} by hand, or void and ship again`,
		);
	}
	if (to.kind === "hold")
		return hold({ kind: "unmappable", why: to.why }, to.why);
	const packed = packedOf(contents.lines, order.id);
	const commitmentLines = packed.flatMap((line) =>
		line.orderLineId == null
			? []
			: [{ orderLineId: line.orderLineId, quantity: line.quantity }],
	);
	if (
		commitmentLines.length !== packed.length &&
		(await readQuantityMode(db, "none")) === "committed"
	)
		return hold(
			{
				kind: "unmappable",
				why: "This dispatch has no frozen inventory line identity",
			},
			"Void and repack this dispatch before shipping reserved stock",
		);

	let phase: "delivery" | "recording" = "delivery";
	try {
		const delivered = await deliver(
			db,
			{ to, order, boxes, packed: packedOf(contents.lines, order.id) },
			outside,
		);
		phase = "recording";
		// Recorded together, so a retry never finds it sent while the order is
		// still on To ship.
		await db.transaction(async (tx) => {
			if (
				(await readQuantityMode(tx)) === "committed" &&
				commitmentLines.length !== packed.length
			)
				throw new Error("The dispatch has no frozen inventory line identity");
			await consumeCommitments(tx, {
				orderId: order.id,
				lines: commitmentLines,
				fulfillmentKey: `dispatch:${handoff.dispatchId}:order:${order.id}`,
			});
			await tx
				.update(dispatchOrders)
				.set({
					channelSentAt: new Date(),
					channelFulfillmentId: delivered.fulfillmentId,
					channelError: null,
					channelRetryAt: null,
					handoffHold: null,
				})
				.where(sameMember(member));
			// Shipped now, not on the next sync: off To ship unless the
			// marketplace still has more of it to ship.
			await tx
				.update(orders)
				.set({
					fulfillmentStatus:
						delivered.remaining > 0 ? "PARTIALLY_FULFILLED" : "FULFILLED",
				})
				.where(eq(orders.id, order.id));
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		if (err instanceof Held) return hold(err.hold, detail);
		const why =
			phase === "recording"
				? `Marketplace accepted tracking; inventory recording failed: ${detail}`
				: detail;
		const now = new Date();
		const firstFailedAt = handoff.channelFirstFailedAt ?? now;
		const attempts = handoff.channelAttempts + 1;
		const retryAt = nextRetry(firstFailedAt, attempts, now);
		await db
			.update(dispatchOrders)
			.set({
				channelError: why,
				channelFirstFailedAt: firstFailedAt,
				channelAttempts: attempts,
				channelRetryAt: retryAt,
				handoffHold: null,
			})
			.where(sameMember(member));
		return done(
			false,
			`${phase === "recording" ? "Dispatch not recorded" : `Tracking didn't reach ${name}`}: ${why}${retryAt ? ". Retrying on its own; Diagnostics shows it if it gives up" : ""}`,
		);
	}
	return done(
		true,
		to.kind === "tiktok"
			? "Ready for pickup on TikTok; TikTok tells the customer"
			: to.kind === "ebay" && boxes.length > 1
				? `Tracking sent to eBay; eBay takes one number, so the customer sees box 1's (${boxes[0].trackingNumber})`
				: `Tracking sent to ${name}; the customer is emailed`,
		true,
	);
}

const sameMember = (member: Member) =>
	and(
		eq(dispatchOrders.dispatchId, member.handoff.dispatchId),
		eq(dispatchOrders.orderId, member.handoff.orderId),
	);

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
