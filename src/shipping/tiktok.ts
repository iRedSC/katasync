import { type } from "arktype";
import { shopCipher, tiktokApi } from "#/channels/tiktok";
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
		line_items: type({ id: "string", "display_status?": "string" }).array(),
	}).array(),
});

// The unit line items a label covers: every one not cancelled. Only orders
// TikTok still waits on can get a label; one bought in Seller Center
// already moved the order on.
async function lineItemsToShip(orderId: string, cipher: string) {
	const [order] = orderDetail.assert(
		await tiktokApi("/order/202309/orders", {
			shop_cipher: cipher,
			ids: orderId,
		}),
	).orders;
	if (!order) throw new Error(`TikTok has no order ${orderId}`);
	if (order.status !== "AWAITING_SHIPMENT") {
		throw new Error(
			`TikTok shows this order as ${order.status.toLowerCase().replaceAll("_", " ")}, so it can't take a new label`,
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

function toRate(
	s: NonNullable<(typeof servicesData.infer)["shipping_services"]>,
) {
	return s.map((r) => ({
		id: r.id,
		carrier: r.shipping_provider_name ?? "TikTok",
		// The name, not the ID, so quick ship's "picked this last time" ranking
		// survives TikTok renumbering services.
		service: r.name,
		serviceName: r.shipping_provider_name
			? `${r.shipping_provider_name} ${r.name}`
			: r.name,
		cost: Number(r.price) || 0,
		days: r.latest_delivery_days ?? null,
	}));
}

async function quote(orderId: string, cipher: string, parcel: Parcel) {
	const lineItemIds = await lineItemsToShip(orderId, cipher);
	const data = servicesData.assert(
		await tiktokApi(
			`/fulfillment/202309/orders/${orderId}/shipping_services/query`,
			{ shop_cipher: cipher },
			{ order_line_item_ids: lineItemIds, ...toTiktokParcel(parcel) },
		),
	);
	return { lineItemIds, rates: toRate(data.shipping_services ?? []) };
}

// TikTok's prices for this box and weight. Estimates: TikTok charges what
// the carrier bills.
export async function tiktokRates(
	orderId: string,
	parcel: Parcel,
): Promise<Rate[]> {
	return (await quote(orderId, await shopCipher(), parcel)).rates;
}

const createdData = type({ package_id: "string" });
const packageDetail = type({
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
export async function tiktokBuyLabel(
	orderId: string,
	parcel: Parcel,
	serviceId: string,
) {
	const cipher = await shopCipher();
	const { lineItemIds, rates } = await quote(orderId, cipher, parcel);
	const rate = rates.find((r) => r.id === serviceId);
	if (!rate)
		throw new Error("TikTok no longer offers that service; price again");

	const { package_id: packageId } = createdData.assert(
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

	return { packageId, rate };
}

// Marks a package ready to ship, handed over the way TikTok has the shop set
// up (carrier pickup or drop-off); TikTok tells the buyer. Returns the
// package ID as the handoff's record, and the label's tracking number.
// Safe to repeat: a package already shipped is left alone.
export async function tiktokShipPackage(packageId: string) {
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
	const { trackingNumber } = await tiktokLabel(packageId);
	return { id: packageId, trackingNumber };
}

// The label PDF for a package. TikTok's link expires after about a day, so
// it's fetched fresh each time rather than stored.
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

// Where katasync keeps a TikTok label: its own route, which fetches a fresh
// link from TikTok on every open.
export const tiktokLabelPath = (packageId: string) =>
	`/labels/tiktok/${encodeURIComponent(packageId)}`;
