import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import { getDb } from "#/db/client";
import { locations, orders, packages, stores } from "#/db/schema";
import { labelSource } from "#/orders/fulfillment";
import { createBoxes, updateBox } from "#/shipping/boxes";
import { buyDispatch, MAX_BOXES } from "#/shipping/buy";
import { sendTracking, voidDispatch } from "#/shipping/handoff";
import { labelPdf } from "#/shipping/label-file";
import {
	combineRates,
	orderForShipping,
	rankRates,
	serviceHistory,
	shipmentPlan,
} from "#/shipping/quick-ship";
import { type Address, getRates, shippoIsTest } from "#/shipping/shippo";
import { tiktokOrderId, tiktokRates } from "#/shipping/tiktok";

export const listPackages = createServerFn({ method: "GET" }).handler(
	async () => getDb().select().from(packages).orderBy(packages.pin),
);

const boxFields = {
	name: "string > 0",
	lengthIn: "number > 0",
	widthIn: "number > 0",
	heightIn: "number > 0",
	weightOz: "number >= 0",
} as const;

export const savePackage = createServerFn({ method: "POST" })
	.validator(type({ ...boxFields, "pin?": "1 <= number.integer <= 999" }))
	.handler(async ({ data }) => (await createBoxes(getDb(), [data]))[0]);

export const updatePackage = createServerFn({ method: "POST" })
	.validator(
		type({
			...boxFields,
			id: "number.integer > 0",
			pin: "1 <= number.integer <= 999",
		}),
	)
	.handler(async ({ data: { id, ...box } }) => updateBox(getDb(), id, box));

export const deletePackage = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => {
		await getDb().delete(packages).where(eq(packages.id, data.id));
	});

export const quickShipLookup = createServerFn({ method: "GET" })
	.validator(type({ pin: "1 <= number.integer <= 999" }))
	.handler(async ({ data }) => orderForShipping(getDb(), data.pin));

// What's in the box when these orders ship together (the pin's order
// first), for quick ship to show and price.
export const quickShipPlan = createServerFn({ method: "GET" })
	.validator(type({ orderIds: "(number.integer > 0)[] > 0" }))
	.handler(async ({ data }) => shipmentPlan(getDb(), data.orderIds));

const box = {
	packageId: "number.integer > 0 | null",
	lengthMm: "number.integer > 0",
	widthMm: "number.integer > 0",
	heightMm: "number.integer > 0",
	weightGrams: "number.integer > 0",
	insureAmount: "number > 0 | null",
} as const;

const send = {
	orderIds: "(number.integer > 0)[] > 0",
	contentsKey: "string",
} as const;

// The ship-to and ship-from addresses for an order, or why a label can't be
// made yet.
async function addresses(
	orderId: number,
): Promise<{ from: Address; to: Address }> {
	const db = getDb();
	const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
	if (!o) throw new Error(`No order ${orderId}`);
	if (!o.shipAddress1 || !o.shipCity || !o.shipPostalCode || !o.shipCountry) {
		throw new Error(`${o.name} has no full shipping address`);
	}
	const locationId = await shippingLocation(db);
	const [from] = locationId
		? await db.select().from(locations).where(eq(locations.id, locationId))
		: [];
	if (
		!from?.address1 ||
		!from.city ||
		!from.postalCode ||
		!from.country ||
		!from.email
	) {
		throw new Error(
			"The warehouse has no ship-from address or email yet; both come from Shopify (primary location and store contact email)",
		);
	}
	return {
		from: {
			name: from.shipFromName ?? from.name,
			street1: from.address1,
			street2: from.address2,
			city: from.city,
			state: from.region ?? "",
			zip: from.postalCode,
			country: from.country,
			phone: from.phone,
			email: from.email,
		},
		to: {
			name: o.customerName ?? "Customer",
			street1: o.shipAddress1,
			street2: o.shipAddress2,
			city: o.shipCity,
			state: o.shipRegion ?? "",
			zip: o.shipPostalCode,
			country: o.shipCountry,
			phone: o.shipPhone,
		},
	};
}

// Prices for every box, one line per service offered for all of them, most
// likely choice first. TikTok orders get TikTok's own services (one order,
// one box); everything else gets Shippo's carriers. The orders share one
// address (checked again when buying), so the first order's is used.
export const quickShipRates = createServerFn({ method: "POST" })
	.validator(type({ ...send, boxes: type(box).array().atLeastLength(1) }))
	.handler(async ({ data }) => {
		if (data.boxes.length > MAX_BOXES) {
			throw new Error(`At most ${MAX_BOXES} boxes in one shipment`);
		}
		const db = getDb();
		const [first] = await db
			.select({
				channel: stores.channel,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(eq(orders.id, data.orderIds[0]));
		if (!first) throw new Error(`No order ${data.orderIds[0]}`);
		let perBox: Awaited<ReturnType<typeof tiktokRates>>[];
		let notes: string[] = [];
		let test = false;
		if (labelSource(first) === "tiktok") {
			if (data.orderIds.length > 1 || data.boxes.length > 1) {
				throw new Error(
					"TikTok orders ship one order to one box on TikTok's label. Combine or split TikTok packages in TikTok Seller Center.",
				);
			}
			perBox = [
				await tiktokRates(
					tiktokOrderId(first.marketplaceOrderId),
					data.boxes[0],
				),
			];
		} else {
			const where = await addresses(data.orderIds[0]);
			const priced = await Promise.all(
				data.boxes.map((b) =>
					getRates({ ...where, parcel: b, insureAmount: b.insureAmount }),
				),
			);
			perBox = priced.map((p) => p.rates);
			notes = [...new Set(priced.flatMap((p) => p.notes))];
			test = shippoIsTest();
		}
		const history = await serviceHistory(
			db,
			data.contentsKey,
			data.boxes[0].packageId,
		);
		return { rates: rankRates(combineRates(perBox), history), notes, test };
	});

// Buys one label per box with the chosen service, as one dispatch for every
// order in the box, then sends the tracking to each order's marketplace.
// See buyDispatch for what holds when part of it fails.
export const quickShipBuy = createServerFn({ method: "POST" })
	.validator(
		type({
			...send,
			boxes: type({ ...box, rateId: "string > 0" })
				.array()
				.atLeastLength(1),
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const bought = await buyDispatch(db, data);
		const handoff = bought.failed
			? null
			: await sendTracking(db, bought.dispatchId);
		// Saved now so reprints never depend on the provider. A failure here
		// is retried on the first print.
		for (const b of bought.boxes) {
			if (!b.voidedAt) await labelPdf(db, b.id).catch(() => {});
		}
		const live = bought.boxes.filter((b) => !b.voidedAt);
		return {
			dispatchId: bought.dispatchId,
			failed: bought.failed,
			handoff,
			boxes: live.map((b) => ({
				id: b.id,
				trackingNumber: b.trackingNumber,
				cost: b.cost,
			})),
			serviceName: live[0]?.serviceName ?? null,
			provider: live[0]?.provider ?? null,
			test: live.some((b) => b.test),
			cost: live.reduce((sum, b) => sum + b.cost, 0),
		};
	});

// Tries sending a dispatch's tracking to its orders' marketplaces again.
export const resendTracking = createServerFn({ method: "POST" })
	.validator(type({ dispatchId: "number.integer > 0" }))
	.handler(async ({ data }) => sendTracking(getDb(), data.dispatchId));

// Voids every box of a dispatch.
export const voidLabel = createServerFn({ method: "POST" })
	.validator(type({ dispatchId: "number.integer > 0" }))
	.handler(async ({ data }) => voidDispatch(getDb(), data.dispatchId));
