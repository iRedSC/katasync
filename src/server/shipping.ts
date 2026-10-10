import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, eq, isNull } from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import { getDb } from "#/db/client";
import { locations, orders, packages, shipments, stores } from "#/db/schema";
import { labelSource } from "#/orders/fulfillment";
import { createBoxes, updateBox } from "#/shipping/boxes";
import { sendTracking, voidShipment, withOrderLock } from "#/shipping/handoff";
import { labelPdf } from "#/shipping/label-file";
import {
	orderForShipping,
	rankRates,
	serviceHistory,
} from "#/shipping/quick-ship";
import {
	type Address,
	buyLabel,
	getRate,
	getRates,
	shippoIsTest,
} from "#/shipping/shippo";
import { tiktokBuyLabel, tiktokOrderId, tiktokRates } from "#/shipping/tiktok";

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

const parcel = {
	orderId: "number.integer > 0",
	packageId: "number.integer > 0 | null",
	lengthMm: "number.integer > 0",
	widthMm: "number.integer > 0",
	heightMm: "number.integer > 0",
	weightGrams: "number.integer > 0",
	insureAmount: "number > 0 | null",
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

// Who sells this order's label, and the marketplace order it's bought for.
async function labelSeller(orderId: number) {
	const [o] = await getDb()
		.select({
			channel: stores.channel,
			salesChannel: orders.salesChannel,
			marketplaceOrderId: orders.marketplaceOrderId,
		})
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(eq(orders.id, orderId));
	if (!o) throw new Error(`No order ${orderId}`);
	const source = labelSource(o);
	return {
		source,
		tiktokId: source === "tiktok" ? tiktokOrderId(o.marketplaceOrderId) : "",
	};
}

// Prices for this box and weight, most likely choice first. TikTok orders
// get TikTok's own services; everything else gets Shippo's carriers.
export const quickShipRates = createServerFn({ method: "POST" })
	.validator(type({ ...parcel, contentsKey: "string" }))
	.handler(async ({ data }) => {
		const seller = await labelSeller(data.orderId);
		const { rates, notes, test } =
			seller.source === "tiktok"
				? {
						rates: await tiktokRates(seller.tiktokId, data),
						notes: [],
						test: false,
					}
				: {
						...(await getRates({
							...(await addresses(data.orderId)),
							parcel: data,
							insureAmount: data.insureAmount,
						})),
						test: shippoIsTest(),
					};
		const history = await serviceHistory(
			getDb(),
			data.contentsKey,
			data.packageId,
		);
		return { rates: rankRates(rates, history), notes, test };
	});

// Buys the chosen label (from TikTok for TikTok orders, else Shippo),
// records it, and sends the tracking to the order's marketplace. The rate is
// read back from the seller, so the recorded cost and service are theirs,
// not the browser's. One live label per order: the
// check and the purchase hold the order's lock, so a double press or two
// people can't buy twice. (A second box means voiding first, until
// multi-box shipments exist.)
export const quickShipBuy = createServerFn({ method: "POST" })
	.validator(type({ ...parcel, contentsKey: "string", rateId: "string > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const saved = await withOrderLock(db, data.orderId, async (tx) => {
			const [existing] = await tx
				.select({ serviceName: shipments.serviceName })
				.from(shipments)
				.where(
					and(eq(shipments.orderId, data.orderId), isNull(shipments.voidedAt)),
				)
				.limit(1);
			if (existing) {
				throw new Error(
					`This order already has a ${existing.serviceName} label. Void it on the order page to buy a new one.`,
				);
			}
			const box = {
				orderId: data.orderId,
				packageId: data.packageId ?? null,
				contentsKey: data.contentsKey,
				lengthMm: data.lengthMm,
				widthMm: data.widthMm,
				heightMm: data.heightMm,
				weightGrams: data.weightGrams,
			};
			const seller = await labelSeller(data.orderId);
			if (seller.source === "tiktok") {
				// A package TikTok already made for this order is recorded, not
				// bought again (a retry after a lost response).
				const label = await tiktokBuyLabel(seller.tiktokId, data, data.rateId);
				const [row] = await tx
					.insert(shipments)
					.values({
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
					})
					.returning();
				return row;
			}
			const rate = await getRate(data.rateId);
			const label = await buyLabel(data.rateId);
			const [row] = await tx
				.insert(shipments)
				.values({
					...box,
					provider: "shippo",
					carrier: rate.carrier,
					service: rate.service,
					serviceName: rate.serviceName,
					cost: rate.cost,
					insuredAmount: data.insureAmount,
					trackingNumber: label.trackingNumber,
					trackingUrl: label.trackingUrl,
					labelUrl: label.labelUrl,
					externalId: label.id,
					test: shippoIsTest(),
				})
				.returning();
			return row;
		});
		const handoff = await sendTracking(db, saved.id);
		// Saved now so reprints never depend on the provider. A failure here
		// is retried on the first print.
		await labelPdf(db, saved.id).catch(() => {});
		return { ...saved, handoff };
	});

// Tries sending a label's tracking to the marketplace again.
export const resendTracking = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => sendTracking(getDb(), data.id));

export const voidLabel = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => voidShipment(getDb(), data.id));
