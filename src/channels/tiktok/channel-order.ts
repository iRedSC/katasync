import { type } from "arktype";
import type { ChannelOrder } from "#/orders/ingest";
import type { OrderTax } from "#/orders/tax";

// A TikTok order as the Partner API sends it, and as katasync keeps it.

export const tiktokOrder = type({
	id: "string",
	// UNPAID, ON_HOLD, AWAITING_SHIPMENT, PARTIALLY_SHIPPING,
	// AWAITING_COLLECTION, IN_TRANSIT, DELIVERED, COMPLETED, CANCELLED.
	status: "string",
	// Unix seconds.
	create_time: "number",
	update_time: "number",
	"cancel_time?": "number",
	// FULFILLMENT_BY_SELLER, or FULFILLMENT_BY_TIKTOK from TikTok's warehouse.
	"fulfillment_type?": "string",
	// The buyer's TikTok account, unmasked even when the address is.
	"user_id?": "string",
	"payment?": {
		"total_amount?": "string",
		"shipping_fee?": "string",
		// All the order's tax, then its parts.
		"tax?": "string",
		"product_tax?": "string",
		"shipping_fee_tax?": "string",
	},
	"recipient_address?": {
		"name?": "string",
		"phone_number?": "string",
		"address_line1?": "string",
		"address_line2?": "string",
		"postal_code?": "string",
		"region_code?": "string",
		"district_info?": type({
			address_level_name: "string",
			address_name: "string",
			// "TX" for a state, like Shopify's province code.
			"iso_code?": "string",
		}).array(),
	},
	line_items: type({
		id: "string",
		sku_id: "string",
		"seller_sku?": "string",
		product_name: "string",
		"sku_name?": "string",
		sale_price: "string",
		// Taken off sale_price but paid to us by TikTok, not lost.
		"platform_discount?": "string",
		"display_status?": "string",
	}).array(),
});

const fulfillment: Record<string, string> = {
	// Paid, but TikTok holds it an hour in case the buyer cancels.
	ON_HOLD: "ON_HOLD",
	UNPAID: "AWAITING_PAYMENT",
	AWAITING_SHIPMENT: "UNFULFILLED",
	PARTIALLY_SHIPPING: "PARTIALLY_FULFILLED",
	// The label is bought on TikTok; the carrier just hasn't scanned it.
	AWAITING_COLLECTION: "FULFILLED",
	IN_TRANSIT: "FULFILLED",
	DELIVERED: "FULFILLED",
	COMPLETED: "FULFILLED",
	CANCELLED: "FULFILLMENT_NOT_REQUIRED",
};

// When TikTok buys the label, it hides the buyer behind asterisks ("J***n");
// a hidden value is no value.
function shown(value: string | undefined) {
	return value && !value.includes("*") ? value : null;
}

const money = (value: string | undefined) => Number(value ?? 0) || 0;
type Cents = { units: number; cents: number };
const add = (sum: Cents, cents: number): Cents => ({
	units: sum.units + 1,
	cents: sum.cents + cents,
});
const fromUnix = (seconds: number) => new Date(seconds * 1000);

// TikTok collects US sales tax and pays it itself. Whatever of its total the
// named parts don't cover is kept as one more line, so the lines always add
// up to TikTok's own total.
export function tiktokTax(
	payment: (typeof tiktokOrder.infer)["payment"],
): OrderTax {
	const items = money(payment?.product_tax);
	const shipping = money(payment?.shipping_fee_tax);
	const total =
		payment?.tax === undefined ? items + shipping : money(payment.tax);
	return {
		remittedBy: "marketplace",
		lines: [
			{ jurisdiction: "Sales tax on items", rate: null, amount: items },
			{ jurisdiction: "Sales tax on shipping", rate: null, amount: shipping },
			{
				jurisdiction: "Other sales tax",
				rate: null,
				amount: total - items - shipping,
			},
		],
	};
}

export function tiktokToChannelOrder(
	order: typeof tiktokOrder.infer,
): ChannelOrder {
	const fbt = order.fulfillment_type === "FULFILLMENT_BY_TIKTOK";
	const address = order.recipient_address;
	const district = (level: string) => {
		const found = address?.district_info?.find(
			(d) => d.address_level_name.toLowerCase() === level,
		);
		return shown(found?.iso_code || found?.address_name);
	};
	// TikTok lists every unit as its own line item; one line per SKU reads
	// like the other channels and stays stable if a unit is cancelled. A
	// cancelled unit doesn't count, but its line stays (at 0 if all its units
	// went) so ingestion can give back the stock it took. A cancelled order
	// keeps the quantities it was placed with. Units of one SKU can sell at
	// different prices (a discount on one), so the line's price is the average
	// of the units that count, or of all of them when none does.
	const bySku = new Map<
		string,
		{
			line: Omit<ChannelOrder["lines"][number], "quantity" | "unitPrice">;
			counted: Cents;
			all: Cents;
		}
	>();
	for (const item of order.line_items) {
		const counts =
			item.display_status !== "CANCELLED" || order.status === "CANCELLED";
		// What we're paid for the unit: the buyer's price after every discount,
		// plus the part of the discount TikTok funds.
		const cents = Math.round(
			(money(item.sale_price) + money(item.platform_discount)) * 100,
		);
		const sku = bySku.get(item.sku_id) ?? {
			line: {
				externalId: item.sku_id,
				listingExternalId: item.sku_id,
				sku: item.seller_sku || null,
				title:
					item.sku_name && item.sku_name !== "Default"
						? `${item.product_name} - ${item.sku_name}`
						: item.product_name,
			},
			counted: { units: 0, cents: 0 },
			all: { units: 0, cents: 0 },
		};
		sku.all = add(sku.all, cents);
		if (counts) sku.counted = add(sku.counted, cents);
		bySku.set(item.sku_id, sku);
	}
	const lines = [...bySku.values()].map(({ line, counted, all }) => {
		const priced = counted.units > 0 ? counted : all;
		return {
			...line,
			quantity: counted.units,
			// Order lines keep cents, so the average is rounded to one.
			unitPrice: Math.round(priced.cents / priced.units) / 100,
		};
	});
	return {
		externalId: order.id,
		name: order.id,
		// Shopify's TikTok channel used the same name, so older relayed orders
		// and direct ones read alike.
		salesChannel: "TikTok",
		marketplaceOrderId: `tiktok:${order.id}`,
		placedAt: fromUnix(order.create_time),
		cancelledAt:
			order.status === "CANCELLED"
				? fromUnix(order.cancel_time ?? order.update_time)
				: null,
		fulfillmentStatus: fbt
			? "FULFILLMENT_NOT_REQUIRED"
			: (fulfillment[order.status] ?? "UNFULFILLED"),
		fulfilledByChannel: fbt,
		soldInStore: false,
		financialStatus: order.status === "UNPAID" ? "PENDING" : "PAID",
		// A masked name ("D*****") still tells orders apart on the dashboard.
		customerName: address?.name || null,
		buyerId: order.user_id || null,
		shipAddress1: shown(address?.address_line1),
		shipAddress2: shown(address?.address_line2),
		shipCity: district("city"),
		shipRegion: district("state"),
		shipPostalCode: shown(address?.postal_code),
		shipCountry: address?.region_code ?? null,
		shipPhone: shown(address?.phone_number),
		total: money(order.payment?.total_amount),
		shippingCharged: money(order.payment?.shipping_fee),
		tax: tiktokTax(order.payment),
		sourceUpdatedAt: fromUnix(order.update_time),
		lines,
	};
}
