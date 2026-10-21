import type { ChannelOrder } from "#/orders/ingest";
import type { OrderTax } from "#/orders/tax";
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

// Where on Shopify the sale happened: "Online Store", "Point of Sale",
// "Shop", "Draft Orders".
export function shopifySalesChannel(
	o: Pick<ShopifyOrder, "channelInformation" | "app" | "sourceName">,
) {
	return (
		o.channelInformation?.channelDefinition?.channelName ??
		o.app?.name ??
		o.sourceName
	);
}

// Shopify's Shop app is a marketplace: since 2025 Shopify collects and pays
// US sales tax on its orders itself, like Amazon.
export const SHOP_APP = "Shop";

// Tax on our own Shopify sales, online and in the store, is ours to pay, by
// the jurisdictions Shopify charged it for. Shop app orders are Shopify's to
// pay, and so is any order another merchant of record sold for us: Managed
// Markets (Global-e) sells to other countries and pays their VAT and GST. An order Shopify relays from a marketplace (TikTok) was taxed by that
// marketplace, which pays it. Its tax comes titled per product ("Product
// Sales tax: <title>"), so it's named the way TikTok's own orders are
// instead, and adds up the same way.
export function shopifyTax(
	o: Pick<
		ShopifyOrder,
		| "tags"
		| "currentTaxLines"
		| "channelInformation"
		| "app"
		| "sourceName"
		| "merchantOfRecordApp"
	>,
): OrderTax {
	if (tiktokOrderId(o.tags))
		return {
			remittedBy: "marketplace",
			lines: o.currentTaxLines.map((t) => ({
				jurisdiction: /shipping/i.test(t.title)
					? "Sales tax on shipping"
					: "Sales tax on items",
				rate: null,
				amount: t.priceSet.shopMoney.amount,
			})),
		};
	return {
		remittedBy:
			shopifySalesChannel(o) === SHOP_APP || o.merchantOfRecordApp
				? "marketplace"
				: "seller",
		lines: o.currentTaxLines.map((t) => ({
			jurisdiction: t.title,
			rate: t.rate,
			amount: t.priceSet.shopMoney.amount,
		})),
	};
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
		salesChannel: shopifySalesChannel(o),
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
		tax: shopifyTax(o),
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
