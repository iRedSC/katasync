// The order search: plain words search the order's name, pin, customer,
// city, and its lines' SKUs and titles; a word starting with a sigil filters
// (lib/facet-search.ts), with the product search's sigils where they mean
// the same thing:
//
//   $tiktok        %unfulfilled     ~last_week     by marketplace, status, day placed
//   $!tiktok       %!unfulfilled                   exclude
//   ^total  ^!date                                 sort, see products/sort.ts
//
// $ is where it was sold, as products' $ is who makes it: Shopify, Amazon,
// eBay, or TikTok, so a TikTok sale relayed through Shopify is $tiktok.
// % is the status badge as one word (ORDER_STATUSES), plus %unmatched for
// an order with a product katasync doesn't know yet.

import { brandOf } from "#/components/channel-badge";
import { type Chip, defineSearch } from "#/lib/facet-search";
import { channelName } from "#/lib/format";
import { DATE, NUMBER, TEXT } from "#/products/sort";
import { ORDER_STATUSES, orderStatus, type ReturnStage } from "./status";

// What the search reads from an order: the columns the orders list loads.
export type SearchableOrder = {
	name: string;
	pin: number | null;
	placedAt: Date;
	customerName: string | null;
	shipCity: string | null;
	shipRegion: string | null;
	channel: string;
	salesChannel: string | null;
	marketplaceOrderId: string | null;
	externalId: string;
	shipCountry: string | null;
	cancelledAt: Date | null;
	fulfillmentStatus: string;
	financialStatus: string | null;
	labelToVoid: boolean;
	fulfilledByChannel: boolean;
	returnStage: ReturnStage;
	total: number;
	items: number;
	unmatched: number;
	lines: readonly {
		title: string;
		sku: string | null;
		productSku: string | null;
		productName: string | null;
	}[];
};

const MARKETPLACES = {
	shopify: "Shopify",
	shop: "Shop app",
	amazon: "Amazon",
	ebay: "eBay",
	tiktok: "TikTok",
} as const;

// Each status word and what it means: the badge's words.
export const STATUS_DETAILS: ReadonlyMap<string, string> = new Map([
	...Object.entries(ORDER_STATUSES),
	["external", "Unfulfilled, shipped from the marketplace"],
	["unmatched", "Unknown product"],
]);

// Where it was sold. A sale from a source with no marketplace of its own,
// like Draft Orders, goes by that source's name.
export function marketplaceOf(o: {
	channel: string;
	salesChannel: string | null;
}) {
	const brand = brandOf(o.channel, o.salesChannel);
	return brand
		? MARKETPLACES[brand]
		: (o.salesChannel ?? channelName(o.channel));
}

export const orderSearch = defineSearch<
	SearchableOrder,
	"marketplace" | "status" | "placed"
>({
	fields: {
		status: {
			kind: "values",
			sigil: "%",
			label: "status",
			menu: "Status",
			words: ["status"],
			of: (o) => [orderStatus(o).key, o.unmatched > 0 ? "unmatched" : null],
			known: [...STATUS_DETAILS.keys()],
			details: STATUS_DETAILS,
			// Any other word could never match.
			closed: true,
		},
		marketplace: {
			kind: "values",
			sigil: "$",
			label: "sold on",
			menu: "Marketplace",
			words: ["marketplace", "channel", "sold"],
			of: marketplaceOf,
			// A source no order has come from yet can still be watched for.
			known: Object.values(MARKETPLACES),
		},
		placed: {
			kind: "period",
			sigil: "~",
			label: "placed",
			menu: "Placed",
			words: ["placed", "date", "when"],
			at: (o) => o.placedAt,
		},
	},
	text: (o) => [
		o.name,
		o.pin,
		o.customerName,
		o.shipCity,
		o.shipRegion,
		...o.lines.flatMap((l) => [l.sku, l.title, l.productSku, l.productName]),
	],
});

export type OrderFilter = Chip<"marketplace" | "status" | "placed">;

export const ORDER_SORTS = {
	pin: { label: "Pin", ...NUMBER },
	order: { label: "Order", ...TEXT },
	date: { label: "Date", ...DATE },
	customer: { label: "Customer", ...TEXT },
	marketplace: { label: "Marketplace", ...TEXT },
	total: { label: "Total", ...NUMBER },
	items: { label: "Items", ...NUMBER },
	status: { label: "Status", ...TEXT },
} as const;
export type OrderSortKey = keyof typeof ORDER_SORTS;

export function sortValuesOf(o: SearchableOrder) {
	return {
		pin: o.pin,
		order: o.name,
		date: o.placedAt.getTime(),
		customer: o.customerName,
		marketplace: marketplaceOf(o),
		total: o.total,
		items: o.items,
		status: orderStatus(o).label,
	} satisfies Record<OrderSortKey, string | number | null>;
}
