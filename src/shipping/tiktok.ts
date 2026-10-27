import { type } from "arktype";
import { shopCipher, TiktokError, tiktokApi } from "#/channels/tiktok";
import { shipsAerosols } from "./hazmat";
import { LabelRefused, type Lookup } from "./label-attempt-state";
import { overShown } from "./price-check";
import type { Parcel, Rate } from "./shippo";
import { combinedPackageFor, type TiktokOrderUnits } from "./tiktok-units";

// TikTok sells its own labels for TikTok orders (shipping_type TIKTOK), paid
// out of the shop's settlement. Buying one marks the order shipped on TikTok,
// so there's no tracking to hand over afterwards. There's no API to cancel
// one; that's done in Seller Center.

const MM_PER_INCH = 25.4;
const GRAMS_PER_POUND = 453.59237;

// TikTok takes pounds and inches as decimal strings.
export function toTiktokParcel(p: Parcel) {
	const inches = (mm: number) => (mm / MM_PER_INCH).toFixed(2);
	return {
		weight: {
			value: (p.weightGrams / GRAMS_PER_POUND).toFixed(2),
			unit: "POUND",
		},
		dimension: {
			length: inches(p.lengthMm),
			width: inches(p.widthMm),
			height: inches(p.heightMm),
			unit: "INCH",
		},
	};
}

// The TikTok order ID behind a katasync order, whether it came straight from
// TikTok or through Shopify's TikTok channel.
export function tiktokOrderId(marketplaceOrderId: string | null) {
	if (!marketplaceOrderId?.startsWith("tiktok:")) {
		throw new Error("This order has no TikTok order ID");
	}
	return marketplaceOrderId.slice("tiktok:".length);
}

const orderDetail = type({
	orders: type({
		id: "string",
		status: "string",
		// Packages already made for the order, however they were bought.
		"packages?": type({ id: "string" }).array(),
		line_items: type({
			id: "string",
			"display_status?": "string",
			"sku_id?": "string",
			"seller_sku?": "string",
			"package_id?": "string",
		}).array(),
	}).array(),
});

async function orderOf(orderId: string, cipher: string) {
	const [order] = orderDetail.assert(
		await tiktokApi("/order/202309/orders", {
			shop_cipher: cipher,
			ids: orderId,
		}),
	).orders;
	if (!order) throw new Error(`TikTok has no order ${orderId}`);
	return order;
}

// Every unit TikTok lists on the order, and its packages. Reads only.
export async function tiktokOrderUnits(
	orderId: string,
): Promise<TiktokOrderUnits> {
	const order = await orderOf(orderId, await shopCipher());
	return {
		status: order.status,
		packages: (order.packages ?? []).map((p) => p.id),
		units: order.line_items.map((l) => ({
			id: l.id,
			skuId: l.sku_id || null,
			sellerSku: l.seller_sku || null,
			cancelled: l.display_status === "CANCELLED",
			packageId: l.package_id || null,
		})),
	};
}

// The unit line items a label covers: every one not cancelled. Only orders
// TikTok still waits on can get a label; one bought in Seller Center
// already moved the order on.
async function lineItemsToShip(orderId: string, cipher: string) {
	const order = await orderOf(orderId, cipher);
	if (order.status !== "AWAITING_SHIPMENT") {
		throw new Error(
			`TikTok order is ${order.status.toLowerCase().replaceAll("_", " ")}; no new label`,
		);
	}
	return order.line_items
		.filter((l) => l.display_status !== "CANCELLED")
		.map((l) => l.id);
}

const servicesData = type({
	"shipping_services?": type({
		id: "string",
		name: "string",
		price: "string",
		"currency?": "string",
		"latest_delivery_days?": "number",
		"shipping_provider_name?": "string",
	}).array(),
});

// TikTok writes label prices as "$7.69", unlike the plain numbers on orders.
// A price it can't read stops the sale rather than passing as free.
export function labelPrice(price: string) {
	const value = Number(price.replace(/[$,]/g, ""));
	if (!price.trim() || !Number.isFinite(value)) {
		throw new Error(`TikTok gave an unreadable label price: ${price}`);
	}
	return value;
}

function toRate(
	s: NonNullable<(typeof servicesData.infer)["shipping_services"]>,
) {
	return s.map((r) => ({
		id: r.id,
		carrier: r.shipping_provider_name ?? "TikTok",
		// The name, not the ID, so quick ship's "picked this last time" ranking
		// survives TikTok renumbering services.
		service: r.name,
		// TikTok's names already lead with the carrier ("UPS® Ground").
		serviceName:
			r.shipping_provider_name && !r.name.startsWith(r.shipping_provider_name)
				? `${r.shipping_provider_name} ${r.name}`
				: r.name,
		cost: labelPrice(r.price),
		days: r.latest_delivery_days ?? null,
	}));
}

// A box with aerosols only gets ground services; TikTok has no way to be
// told, so the mark printed with the label is the declaration.
type Box = Parcel & { hazmat: boolean };

async function quote(
	orderId: string,
	cipher: string,
	parcel: Box,
	unitIds?: string[],
) {
	const lineItemIds = unitIds ?? (await lineItemsToShip(orderId, cipher));
	const data = servicesData.assert(
		await tiktokApi(
			`/fulfillment/202309/orders/${orderId}/shipping_services/query`,
			{ shop_cipher: cipher },
			{ order_line_item_ids: lineItemIds, ...toTiktokParcel(parcel) },
		),
	);
	const rates = toRate(data.shipping_services ?? []);
	return {
		lineItemIds,
		rates: parcel.hazmat ? rates.filter(shipsAerosols) : rates,
	};
}

// TikTok's prices for this box and weight. Estimates: TikTok charges what
// the carrier bills.
export async function tiktokRates(
	orderId: string,
	parcel: Box,
): Promise<Rate[]> {
	return (await quote(orderId, await shopCipher(), parcel)).rates;
}

const createdData = type({
	package_id: "string",
	// The service TikTok used, with its price.
	"shipping_service_info?": { "price?": "string" },
});
const packageDetail = type({
	"shipping_provider_name?": "string",
	// PROCESSING until the carrier has it; RTS (ready to ship) once shipped.
	"package_status?": "string",
	"package_sub_status?": "string",
	"handover_method?": "string",
});
const documentData = type({ doc_url: "string", "tracking_number?": "string" });

// Buys the label for the chosen service, for exactly these units (checked
// against the box by the caller, and saved with the attempt). The service is
// quoted again, so what gets recorded is TikTok's price, not the browser's,
// and a quote above `shown` (the price on screen) is refused before the
// package is created.
// Several orders make one combined package (ship_type 3), every unit of each
// order in it; TikTok checks they share a buyer, address, and warehouse, and
// refuses the label if not. TikTok quotes one order at a time, so a combined
// box is quoted on the first order's units at the whole box's size.
// Creating the package is the step that costs money. Telling TikTok it's
// ready to ship, and picking up the tracking number, is the handoff's job
// (tiktokShipPackage), so a failure there can be retried. A package that
// already exists is never taken as this purchase; an unanswered one is
// found by tiktokFindLabel.
//
// Everything before creating the package only reads, so its failures are
// refusals (nothing bought). TikTok's own error answer to the create is a
// refusal too; anything else there leaves it unknown.
export async function tiktokBuyLabel(
	orderIds: string[],
	parcel: Box,
	serviceId: string,
	unitIds: string[],
	shown: number,
) {
	const [lead] = orderIds;
	if (!lead) throw new LabelRefused("No TikTok order to buy for");
	const combined = orderIds.length > 1;
	const before = async () => {
		const cipher = await shopCipher();
		const { rates } = await quote(
			lead,
			cipher,
			parcel,
			combined ? undefined : unitIds,
		);
		const rate = rates.find((r) => r.id === serviceId);
		if (!rate)
			throw new Error("TikTok no longer offers that service; price again");
		const rose = overShown([rate.cost], shown);
		if (rose) throw new Error(rose);
		return { cipher, rate };
	};
	const { cipher, rate } = await before().catch((err: unknown) => {
		throw new LabelRefused(err instanceof Error ? err.message : String(err));
	});

	const created = createdData.assert(
		await (combined
			? tiktokApi(
					"/fulfillment/202512/packages",
					{ shop_cipher: cipher },
					{
						ship_type: "3",
						order_list_ids: orderIds,
						shipping_service_id: serviceId,
						...toTiktokParcel(parcel),
					},
				)
			: tiktokApi(
					"/fulfillment/202309/packages",
					{ shop_cipher: cipher },
					{
						order_id: lead,
						order_line_item_ids: unitIds,
						shipping_service_id: serviceId,
						...toTiktokParcel(parcel),
					},
				)
		).catch((err: unknown) => {
			if (err instanceof TiktokError) throw new LabelRefused(err.message);
			throw err;
		}),
	);

	// The label is bought by now, so a price TikTok left out or garbled
	// falls back to the quote rather than throwing.
	const charged = Number(
		created.shipping_service_info?.price?.replace(/[$,]/g, ""),
	);
	return {
		packageId: created.package_id,
		rate:
			Number.isFinite(charged) && charged > 0
				? { ...rate, cost: charged }
				: rate,
	};
}

// Whether TikTok made the package for an unanswered purchase: only one
// covering exactly its units, across every order in the box (see
// combinedPackageFor). Reads only.
export async function tiktokFindLabel(
	orderIds: string[],
	unitIds: string[],
): Promise<Lookup> {
	return combinedPackageFor(
		await Promise.all(orderIds.map((id) => tiktokOrderUnits(id))),
		unitIds,
	);
}

// TikTok's answers for a package it's still working on: "arrange shipment
// before retrieving the shipping document" (it takes /ship but arranges it
// in the background) and "the order is being processed, try again later"
// (right after the package is created, or while the label is generated).
// Both clear on their own within seconds.
const STILL_PROCESSING = new Set([21023035, 21001028]);
// How long to wait for that, in all about ten seconds.
const DOCUMENT_WAITS_MS = [1000, 2000, 3000, 4000];

function stillProcessing(err: unknown) {
	return err instanceof TiktokError && STILL_PROCESSING.has(err.code);
}

// Calls TikTok until it's done processing the package, waiting between
// tries. Any other refusal, or still processing after the last wait,
// throws.
async function onceProcessed<T>(call: () => Promise<T>, waitsMs: number[]) {
	for (const wait of waitsMs) {
		try {
			return await call();
		} catch (err) {
			if (!stillProcessing(err)) throw err;
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}
	return call();
}

// Marks a package ready to ship, handed over the way TikTok has the shop set
// up (carrier pickup or drop-off); TikTok tells the buyer. Returns the
// package ID as the handoff's record, and the label's tracking number.
// Safe to repeat: a package already shipped is left alone.
//
// Once /ship is taken the package is shipped as far as TikTok is concerned,
// so a label still being processed after the wait gives no tracking number
// rather than a failure; printing the label picks the number up later
// (label-file.ts).
export async function tiktokShipPackage(
	packageId: string,
	waitsMs = DOCUMENT_WAITS_MS,
) {
	const cipher = await shopCipher();
	const pkg = packageDetail.assert(
		await tiktokApi(`/fulfillment/202309/packages/${packageId}`, {
			shop_cipher: cipher,
		}),
	);
	const shipped =
		pkg.package_sub_status === "RTS" || pkg.package_status !== "PROCESSING";
	if (!shipped) {
		await onceProcessed(
			() =>
				tiktokApi(
					`/fulfillment/202309/packages/${packageId}/ship`,
					{ shop_cipher: cipher },
					pkg.handover_method ? { handover_method: pkg.handover_method } : {},
				),
			waitsMs,
		);
	}
	try {
		const { trackingNumber } = await tiktokLabel(packageId, waitsMs);
		return { id: packageId, trackingNumber };
	} catch (err) {
		if (!stillProcessing(err)) throw err;
		return { id: packageId, trackingNumber: null };
	}
}

// The label PDF link for a package, waiting while TikTok still processes
// it. It expires after about a day; katasync saves the PDF itself
// (label-file.ts).
export async function tiktokLabel(
	packageId: string,
	waitsMs = DOCUMENT_WAITS_MS,
) {
	const cipher = await shopCipher();
	const data = await onceProcessed(
		async () =>
			documentData.assert(
				await tiktokApi(
					`/fulfillment/202309/packages/${packageId}/shipping_documents`,
					{
						shop_cipher: cipher,
						document_type: "SHIPPING_LABEL",
						// 4x6.
						document_size: "A6",
						document_format: "PDF",
					},
				),
			),
		waitsMs,
	);
	return { url: data.doc_url, trackingNumber: data.tracking_number || null };
}
