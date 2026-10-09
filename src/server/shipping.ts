import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, eq, isNull } from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import { getDb } from "#/db/client";
import { locations, orders, packages, shipments } from "#/db/schema";
import { sendTracking, voidShipment } from "#/shipping/handoff";
import {
	freePackagePin,
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

const MM_PER_INCH = 25.4;
const GRAMS_PER_OUNCE = 28.349523125;

export const listPackages = createServerFn({ method: "GET" }).handler(
	async () => getDb().select().from(packages).orderBy(packages.pin),
);

// Boxes are entered in inches and ounces, the units on the tape measure and
// scale, and stored in millimeters and grams like everything else.
export const savePackage = createServerFn({ method: "POST" })
	.validator(
		type({
			name: "string > 0",
			lengthIn: "number > 0",
			widthIn: "number > 0",
			heightIn: "number > 0",
			weightOz: "number >= 0",
			"pin?": "1 <= number.integer <= 999",
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const [saved] = await db
			.insert(packages)
			.values({
				name: data.name.trim(),
				pin: data.pin ?? (await freePackagePin(db)),
				lengthMm: Math.round(data.lengthIn * MM_PER_INCH),
				widthMm: Math.round(data.widthIn * MM_PER_INCH),
				heightMm: Math.round(data.heightIn * MM_PER_INCH),
				weightGrams: Math.round(data.weightOz * GRAMS_PER_OUNCE),
			})
			.returning();
		return saved;
	});

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
	"packageId?": "number.integer > 0",
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

// Prices for this box and weight, most likely choice first.
export const quickShipRates = createServerFn({ method: "POST" })
	.validator(type({ ...parcel, contentsKey: "string" }))
	.handler(async ({ data }) => {
		const { from, to } = await addresses(data.orderId);
		const { rates, notes } = await getRates({
			from,
			to,
			parcel: data,
			insureAmount: data.insureAmount,
		});
		const history = await serviceHistory(
			getDb(),
			data.contentsKey,
			data.packageId ?? null,
		);
		return { rates: rankRates(rates, history), notes, test: shippoIsTest() };
	});

// Buys the chosen label, records it, and sends the tracking to the order's
// marketplace. The rate is read back from Shippo, so the recorded cost and
// service are Shippo's, not the browser's. An order that already has a live
// label only gets another when asked (a second box), never by a double press.
export const quickShipBuy = createServerFn({ method: "POST" })
	.validator(
		type({
			...parcel,
			contentsKey: "string",
			rateId: "string > 0",
			"another?": "boolean",
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const [existing] = await db
			.select({ serviceName: shipments.serviceName })
			.from(shipments)
			.where(
				and(eq(shipments.orderId, data.orderId), isNull(shipments.voidedAt)),
			)
			.limit(1);
		if (existing && !data.another) {
			throw new Error(
				`This order already has a ${existing.serviceName} label. Void it first, or confirm a second box.`,
			);
		}
		const rate = await getRate(data.rateId);
		const label = await buyLabel(data.rateId);
		const [saved] = await db
			.insert(shipments)
			.values({
				orderId: data.orderId,
				packageId: data.packageId ?? null,
				contentsKey: data.contentsKey,
				lengthMm: data.lengthMm,
				widthMm: data.widthMm,
				heightMm: data.heightMm,
				weightGrams: data.weightGrams,
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
		return { ...saved, handoff: await sendTracking(db, saved.id) };
	});

// Tries sending a label's tracking to the marketplace again.
export const resendTracking = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => sendTracking(getDb(), data.id));

export const voidLabel = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => voidShipment(getDb(), data.id));
