import { type } from "arktype";
import { eq } from "drizzle-orm";
import { API as EBAY, accessToken as ebayToken } from "#/channels/ebay";
import { shopifyQuery } from "#/channels/shopify/client";
import { shopCipher, tiktokApi } from "#/channels/tiktok";
import type { Db } from "#/db/client";
import { type ChannelPackage, orderChannelTracking } from "#/db/schema";
import {
	type Carrier,
	guessCarrier,
	normalTracking,
} from "#/purchasing/inbox/tracking-numbers";

// The packages a channel says an order went out in, whoever bought the
// label: katasync, or the channel's own site (TikTok Shipping, Shopify's
// admin, eBay). Read once an order has shipped and kept, then read again
// only when the order changes, so an order looked at twice asks once. A
// read that fails keeps what was known. Amazon isn't asked: its Orders API
// here doesn't say. Server only.

type Order = {
	id: number;
	channel: string;
	externalId: string;
	fulfillmentStatus: string;
	sourceUpdatedAt: Date;
};

const SHIPPED = new Set(["FULFILLED", "PARTIALLY_FULFILLED"]);

// The carrier Shippo follows, from whatever a channel calls it ("FedEx",
// "FEDEX", "UPS Ground", "USPS"), or by the number's shape.
export function carrierOf(name: string, number: string): Carrier | null {
	const n = name.toLowerCase();
	if (n.includes("fedex")) return "fedex";
	if (n.includes("usps") || n.includes("postal")) return "usps";
	if (/\bups\b/.test(n)) return "ups";
	return guessCarrier(normalTracking(number));
}

// One per number: lines sharing a package share its number.
const distinct = (all: ChannelPackage[]) => [
	...new Map(
		all
			.filter((p) => p.number.trim())
			.map((p) => [
				normalTracking(p.number),
				{ ...p, number: p.number.trim() },
			]),
	).values(),
];

const tiktokOrders = type({
	"orders?": type({
		"tracking_number?": "string",
		"shipping_provider?": "string",
		"line_items?": type({
			"tracking_number?": "string",
			"shipping_provider_name?": "string",
			"+": "ignore",
		}).array(),
		"+": "ignore",
	}).array(),
	"+": "ignore",
});

async function fromTiktok(id: string) {
	const [o] =
		tiktokOrders.assert(
			await tiktokApi("/order/202309/orders", {
				shop_cipher: await shopCipher(),
				ids: id,
			}),
		).orders ?? [];
	return distinct([
		...(o?.line_items ?? []).map((l) => ({
			carrier: l.shipping_provider_name ?? o?.shipping_provider ?? "",
			number: l.tracking_number ?? "",
		})),
		{ carrier: o?.shipping_provider ?? "", number: o?.tracking_number ?? "" },
	]);
}

const shopifyFulfillments = type({
	"order?": type({
		fulfillments: type({
			status: "string",
			trackingInfo: type({
				"company?": "string | null",
				"number?": "string | null",
			}).array(),
		}).array(),
	}).or("null"),
});

const SHOPIFY_QUERY = `
query Tracking($id: ID!) {
	order(id: $id) {
		fulfillments(first: 20) { status trackingInfo(first: 10) { company number } }
	}
}`;

// Fulfillments that never went out.
const NOT_SHIPPED = new Set(["CANCELLED", "ERROR", "FAILURE"]);

async function fromShopify(id: string) {
	const page = shopifyFulfillments.assert(
		await shopifyQuery(SHOPIFY_QUERY, { id }, { timeoutMs: 10_000 }),
	);
	return distinct(
		(page.order?.fulfillments ?? [])
			.filter((f) => !NOT_SHIPPED.has(f.status))
			.flatMap((f) =>
				f.trackingInfo.map((t) => ({
					carrier: t.company ?? "",
					number: t.number ?? "",
				})),
			),
	);
}

const ebayFulfillments = type({
	"fulfillments?": type({
		"shipmentTrackingNumber?": "string",
		"shippingCarrierCode?": "string",
		"+": "ignore",
	}).array(),
	"+": "ignore",
});

async function fromEbay(id: string) {
	const res = await fetch(
		`${EBAY}/sell/fulfillment/v1/order/${encodeURIComponent(id)}/shipping_fulfillment`,
		{
			headers: { Authorization: `Bearer ${await ebayToken()}` },
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!res.ok) throw new Error(`eBay answered ${res.status}`);
	return distinct(
		(ebayFulfillments.assert(await res.json()).fulfillments ?? []).map((f) => ({
			carrier: f.shippingCarrierCode ?? "",
			number: f.shipmentTrackingNumber ?? "",
		})),
	);
}

const READERS: Record<string, (id: string) => Promise<ChannelPackage[]>> = {
	tiktok: fromTiktok,
	shopify: fromShopify,
	ebay: fromEbay,
};

// What the channel says, read now when it hasn't been since the order last
// changed; what was known when it can't be asked.
export async function channelPackages(
	db: Db,
	order: Order,
): Promise<ChannelPackage[]> {
	const [kept] = await db
		.select()
		.from(orderChannelTracking)
		.where(eq(orderChannelTracking.orderId, order.id));
	const read = READERS[order.channel];
	if (
		!read ||
		!SHIPPED.has(order.fulfillmentStatus) ||
		kept?.readFor.getTime() === order.sourceUpdatedAt.getTime()
	)
		return kept?.packages ?? [];
	try {
		const packages = await read(order.externalId);
		await db
			.insert(orderChannelTracking)
			.values({ orderId: order.id, packages, readFor: order.sourceUpdatedAt })
			.onConflictDoUpdate({
				target: orderChannelTracking.orderId,
				set: { packages, readFor: order.sourceUpdatedAt },
			});
		return packages;
	} catch {
		return kept?.packages ?? [];
	}
}
