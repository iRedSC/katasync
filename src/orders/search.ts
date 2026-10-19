// The order search language, with the product search's sigils where they
// mean the same thing. Plain words search the order's name, pin, customer,
// and city; a word starting with a sigil filters instead:
//
//   $tiktok        %unfulfilled     filter by marketplace, by status
//   $!tiktok       %!unfulfilled    exclude
//   ^total  ^!date                  sort, see products/sort.ts
//
// $ is where it was sold, as products' $ is who makes it: Shopify, Amazon,
// eBay, or TikTok, so a TikTok sale relayed through Shopify is $tiktok.
// % is the status badge as one word (ORDER_STATUSES), plus %unmatched for
// an order with a product katasync doesn't know yet.
//
// As with products: several filters on one field match any of them, different
// fields must all match, and exclusions all apply. A filter still being typed
// matches by substring, so the list narrows live; a chip matches exactly.

import { type } from "arktype";
import { brandOf } from "#/components/channel-badge";
import type { SearchLanguage } from "#/components/filter-search";
import { channelName } from "#/lib/format";
import { DATE, NUMBER, parseSortWord, TEXT } from "#/products/sort";
import { ORDER_STATUSES, orderStatus } from "./status";

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
	cancelledAt: Date | null;
	fulfillmentStatus: string;
	financialStatus: string | null;
	labelToVoid: boolean;
	total: number;
	items: number;
	unmatched: number;
};

export const ORDER_FIELDS = ["marketplace", "status"] as const;
export type OrderField = (typeof ORDER_FIELDS)[number];

export type OrderFilter = {
	field: OrderField;
	value: string;
	exclude: boolean;
	// Chips match the whole value; words still being typed match a part.
	exact: boolean;
};

export const ORDER_SIGILS = {
	$: "marketplace",
	"%": "status",
} as const satisfies Record<string, OrderField>;

const LABEL: Record<OrderField, string> = {
	marketplace: "sold on",
	status: "status",
};

const MARKETPLACES = {
	shopify: "Shopify",
	amazon: "Amazon",
	ebay: "eBay",
	tiktok: "TikTok",
} as const;

// Each status word and what it means: the badge's words.
export const STATUS_DETAILS: ReadonlyMap<string, string> = new Map([
	...Object.entries(ORDER_STATUSES),
	["unmatched", "Unknown product"],
]);

export type OrderFacets = Record<OrderField | "text", string[]>;

// Where it was sold. A sale from a source with no marketplace of its own,
// like Draft Orders, goes by that source's name.
function marketplaceOf(o: SearchableOrder) {
	const brand = brandOf(o.channel, o.salesChannel);
	return brand
		? MARKETPLACES[brand]
		: (o.salesChannel ?? channelName(o.channel));
}

export function facetsOf(o: SearchableOrder): OrderFacets {
	const status: string[] = [orderStatus(o).key];
	if (o.unmatched > 0) status.push("unmatched");
	return {
		marketplace: [marketplaceOf(o)],
		status,
		text: [
			o.name,
			o.pin === null ? "" : String(o.pin),
			o.customerName ?? "",
			o.shipCity ?? "",
			o.shipRegion ?? "",
		].filter(Boolean),
	};
}

// One typed word as a filter, or null when it's plain search text. A bare
// sigil ("$") is a filter with an empty value: it matches everything but
// tells autocomplete which field to suggest.
export function parseWord(word: string): OrderFilter | null {
	const field = ORDER_SIGILS[word[0] as keyof typeof ORDER_SIGILS];
	if (!field) return null;
	const exclude = word[1] === "!";
	return { field, value: word.slice(exclude ? 2 : 1), exclude, exact: false };
}

// Sorts typed but not yet locked in come back as `sorts`, for the page to
// apply once one names a column.
export function parseQuery(text: string) {
	const filters: OrderFilter[] = [];
	const words: string[] = [];
	const sorts: NonNullable<ReturnType<typeof parseSortWord>>[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const filter = parseWord(word);
		const sort = parseSortWord(word);
		if (filter) filters.push(filter);
		else if (sort) sorts.push(sort);
		else words.push(word.toLowerCase());
	}
	return { filters, words, sorts };
}

function hits(values: string[], f: OrderFilter) {
	const v = f.value.toLowerCase();
	return values.some((x) =>
		f.exact ? x.toLowerCase() === v : x.toLowerCase().includes(v),
	);
}

export function matches(
	facets: OrderFacets,
	filters: readonly OrderFilter[],
	words: readonly string[],
) {
	const text = facets.text.map((t) => t.toLowerCase());
	if (!words.every((w) => text.some((t) => t.includes(w)))) return false;
	const active = filters.filter((f) => f.value !== "");
	if (active.some((f) => f.exclude && hits(facets[f.field], f))) return false;
	return ORDER_FIELDS.every((field) => {
		const wanted = active.filter((f) => f.field === field && !f.exclude);
		return wanted.length === 0 || wanted.some((f) => hits(facets[field], f));
	});
}

// Every value of each field across these orders, with how many have it.
// Every marketplace and status is listed, even with none, so the
// suggestions teach them all.
export function facetCounts(all: readonly OrderFacets[]) {
	const counts = new Map<OrderField, Map<string, number>>([
		["marketplace", new Map(Object.values(MARKETPLACES).map((m) => [m, 0]))],
		["status", new Map([...STATUS_DETAILS.keys()].map((k) => [k, 0]))],
	]);
	for (const facets of all) {
		for (const field of ORDER_FIELDS) {
			const values = counts.get(field);
			for (const v of new Set(facets[field])) {
				values?.set(v, (values.get(v) ?? 0) + 1);
			}
		}
	}
	return counts;
}

// The chip a picked or typed value locks in as. A status must be one of the
// words, in any case, since any other could never match. A marketplace can
// be any, since a source no order has come from yet can still be watched for.
export function lock(typing: OrderFilter, value: string): OrderFilter | null {
	if (typing.field !== "status") return { ...typing, value, exact: true };
	const key = value.toLowerCase();
	return STATUS_DETAILS.has(key)
		? { ...typing, value: key, exact: true }
		: null;
}

// What the search box needs to speak this language over these counts.
export function orderLanguage(
	counts: ReturnType<typeof facetCounts>,
): SearchLanguage<OrderFilter> {
	return {
		parse: parseWord,
		suggest: (typing, chips) => {
			const q = typing.value.toLowerCase();
			const taken = new Set(
				chips
					.filter((f) => f.field === typing.field)
					.map((f) => f.value.toLowerCase()),
			);
			return [...(counts.get(typing.field) ?? new Map<string, number>())]
				.filter(
					([v]) => v.toLowerCase().includes(q) && !taken.has(v.toLowerCase()),
				)
				.map(([value, count]) => ({
					value,
					count,
					detail: typing.field === "status" ? STATUS_DETAILS.get(value) : "",
					prefix: value.toLowerCase().startsWith(q),
				}))
				.sort(
					(a, b) =>
						Number(b.prefix) - Number(a.prefix) ||
						b.count - a.count ||
						a.value.localeCompare(b.value),
				)
				.slice(0, 8)
				.map(({ prefix: _, ...s }) => s);
		},
		lock,
		label: (f) =>
			!f.exclude
				? LABEL[f.field]
				: f.field === "marketplace"
					? "not sold on"
					: "not status",
		fallback: (typing) =>
			typing.field === "status"
				? `No status “${typing.value}”`
				: `No orders from “${typing.value}”. Tab to use anyway.`,
	};
}

// Chips as they travel through the URL. Anything malformed or naming a
// status that no longer exists is dropped, so an old link still opens.
const chipsType = type({
	field: type.enumerated(...ORDER_FIELDS),
	value: "string",
	exclude: "boolean",
	exact: "boolean",
}).array();

export function chipsFromUrl(raw: unknown): OrderFilter[] {
	const chips = chipsType(raw);
	if (chips instanceof type.errors) return [];
	return chips.flatMap((c) => lock(c, c.value) ?? []);
}

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
