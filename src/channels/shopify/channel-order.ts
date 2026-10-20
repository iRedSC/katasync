import type { ChannelOrder } from "#/orders/ingest";
import type { ShopifyOrder } from "./order-shapes";

// Shopify's TikTok channel tags each order "TikTokOrderID:<id>".
export function tiktokOrderId(tags: string[]) {
	const tag = tags.find((t) => t.startsWith("TikTokOrderID:"));
	return tag ? `tiktok:${tag.slice("TikTokOrderID:".length)}` : null;
}

// Rung up on Shopify POS at our store. Shopify gives such orders the source
// "pos" and the channel "Point of Sale" (what earlier syncs stored, see
// drizzle/0076_retail_store.sql); either is enough.
export function isPosOrder(
	o: Pick<ShopifyOrder, "sourceName" | "channelInformation">,
) {
	return (
		o.sourceName === "pos" ||
		o.channelInformation?.channelDefinition?.channelName === "Point of Sale"
	);
}

// `shipped` is units shipped per line ID, needed when any line has refunded
// or removed units (see shopifyLineQuantity).
export function shopifyToChannelOrder(
	o: ShopifyOrder,
	shipped: Map<string, number> | null,
	remaining: Map<string, number> | null,
): ChannelOrder {
	return {
		externalId: o.id,
		name: o.name,
		salesChannel:
			o.channelInformation?.channelDefinition?.channelName ??
			o.app?.name ??
			o.sourceName,
		marketplaceOrderId: tiktokOrderId(o.tags),
		placedAt: o.createdAt,
		cancelledAt: o.cancelledAt,
		fulfillmentStatus: o.displayFulfillmentStatus,
		fulfilledByChannel: false,
		soldInStore: isPosOrder(o),
		financialStatus: o.displayFinancialStatus,
		customerName: o.shippingAddress?.name ?? null,
		shipCity: o.shippingAddress?.city ?? null,
		shipRegion: o.shippingAddress?.provinceCode ?? null,
		shipCountry: o.shippingAddress?.countryCodeV2 ?? null,
		shipAddress1: o.shippingAddress?.address1 ?? null,
		shipAddress2: o.shippingAddress?.address2 ?? null,
		shipPostalCode: o.shippingAddress?.zip ?? null,
		shipPhone: o.shippingAddress?.phone ?? null,
		total: o.totalPriceSet.shopMoney.amount,
		shippingCharged: o.totalShippingPriceSet.shopMoney.amount,
		sourceUpdatedAt: o.updatedAt,
		lines: o.lineItems.nodes.map((l) => ({
			externalId: l.id,
			listingExternalId: l.variant?.id ?? null,
			sku: l.sku || null,
			title: l.name,
			quantity: shopifyLineQuantity(o, l, shipped, remaining),
			unitPrice: l.discountedUnitPriceAfterAllDiscountsSet.shopMoney.amount,
		})),
	};
}

// Units that leave our stock. Shopify's `quantity` never changes and its
// `currentQuantity` drops on every refund, shipped or not. A unit refunded or
// removed before it shipped never leaves, so its stock comes back; one
// refunded after shipping stays sold until the return is received. A
// cancelled order keeps what it was placed with, since cancelling gives
// everything back anyway.
export function shopifyLineQuantity(
	o: Pick<ShopifyOrder, "cancelledAt">,
	l: { id: string; quantity: number; currentQuantity: number },
	shipped: Map<string, number> | null,
	remaining: Map<string, number> | null,
) {
	if (o.cancelledAt || l.currentQuantity >= l.quantity) return l.quantity;
	if (!shipped || !remaining)
		throw new Error("Shopify fulfillment quantities are unavailable");
	return Math.min(
		l.quantity,
		(shipped.get(l.id) ?? 0) + (remaining.get(l.id) ?? 0),
	);
}
