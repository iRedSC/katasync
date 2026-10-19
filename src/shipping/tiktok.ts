import { type } from "arktype";
import { shopCipher, TiktokError, tiktokApi } from "#/channels/tiktok";
import { shipsAerosols } from "./hazmat";
import type { Parcel, Rate } from "./shippo";

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
		line_items: type({ id: "string", "display_status?": "string" }).array(),
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

async function quote(orderId: string, cipher: string, parcel: Box) {
	const lineItemIds = await lineItemsToShip(orderId, cipher);
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

// Buys the label for the chosen service. The service is quoted again, so
// what gets recorded is TikTok's price, not the browser's. Creating the
// package is the step that costs money. Telling TikTok it's ready to ship,
// and picking up the tracking number, is the handoff's job
// (tiktokShipPackage), so a failure there can be retried.
//
// If the order has already moved past AWAITING_SHIPMENT with a package (a
// purchase whose response was lost, or a label bought in Seller Center), that
// package is returned as recovered instead of buying another. An order still
// awaiting shipment always buys, even if TikTok lists a package for it.
// TikTok doesn't say what a recovered label cost, so its rate is 0 and the
// real charge is in Seller Center.
export async function tiktokBuyLabel(
	orderId: string,
	parcel: Box,
	serviceId: string,
) {
	const cipher = await shopCipher();
	const order = await orderOf(orderId, cipher);
	const [bought] =
		order.status === "AWAITING_SHIPMENT" ? [] : (order.packages ?? []);
	if (bought) {
		const pkg = packageDetail.assert(
			await tiktokApi(`/fulfillment/202309/packages/${bought.id}`, {
				shop_cipher: cipher,
			}),
		);
		const carrier = pkg.shipping_provider_name ?? "TikTok";
		return {
			packageId: bought.id,
			recovered: true,
			rate: {
				id: serviceId,
				carrier,
				service: "Recovered",
				serviceName: `${carrier} (already bought on TikTok)`,
				cost: 0,
				days: null,
			},
		};
	}
	const { lineItemIds, rates } = await quote(orderId, cipher, parcel);
	const rate = rates.find((r) => r.id === serviceId);
	if (!rate)
		throw new Error("TikTok no longer offers that service; price again");

	const created = createdData.assert(
		await tiktokApi(
			"/fulfillment/202309/packages",
			{ shop_cipher: cipher },
			{
				order_id: orderId,
				order_line_item_ids: lineItemIds,
				shipping_service_id: serviceId,
				...toTiktokParcel(parcel),
			},
		),
	);

	// The label is bought by now, so a price TikTok left out or garbled
	// falls back to the quote rather than throwing.
	const charged = Number(
		created.shipping_service_info?.price?.replace(/[$,]/g, ""),
	);
	return {
		packageId: created.package_id,
		recovered: false,
		rate:
			Number.isFinite(charged) && charged > 0
				? { ...rate, cost: charged }
				: rate,
	};
}

// TikTok's "arrange shipment before retrieving the shipping document": it
// takes /ship but arranges it in the background, so the label and its
// tracking number appear a few seconds later.
const SHIPMENT_NOT_ARRANGED = 21023035;
// How long to wait for that, in all about ten seconds.
const DOCUMENT_WAITS_MS = [1000, 2000, 3000, 4000];

// Marks a package ready to ship, handed over the way TikTok has the shop set
// up (carrier pickup or drop-off); TikTok tells the buyer. Returns the
// package ID as the handoff's record, and the label's tracking number.
// Safe to repeat: a package already shipped is left alone.
//
// Once /ship is taken the package is shipped as far as TikTok is concerned,
// so a label still being arranged after the wait gives no tracking number
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
		await tiktokApi(
			`/fulfillment/202309/packages/${packageId}/ship`,
			{ shop_cipher: cipher },
			pkg.handover_method ? { handover_method: pkg.handover_method } : {},
		);
	}
	for (const wait of [...waitsMs, null]) {
		try {
			const { trackingNumber } = await tiktokLabel(packageId);
			return { id: packageId, trackingNumber };
		} catch (err) {
			if (!(err instanceof TiktokError && err.code === SHIPMENT_NOT_ARRANGED))
				throw err;
			if (wait === null) break;
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}
	return { id: packageId, trackingNumber: null };
}

// The label PDF link for a package. It expires after about a day; katasync
// saves the PDF itself (label-file.ts).
export async function tiktokLabel(packageId: string) {
	const data = documentData.assert(
		await tiktokApi(
			`/fulfillment/202309/packages/${packageId}/shipping_documents`,
			{
				shop_cipher: await shopCipher(),
				document_type: "SHIPPING_LABEL",
				// 4x6.
				document_size: "A6",
				document_format: "PDF",
			},
		),
	);
	return { url: data.doc_url, trackingNumber: data.tracking_number || null };
}
