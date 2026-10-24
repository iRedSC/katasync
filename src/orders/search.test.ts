import { describe, expect, test } from "vitest";
import {
	chipsFromUrl,
	facetCounts,
	facetsOf,
	lock,
	matches,
	type OrderFilter,
	orderLanguage,
	parseQuery,
	type SearchableOrder,
} from "./search";

function order(over: Partial<SearchableOrder> = {}): SearchableOrder {
	return {
		name: "#1001",
		pin: 4,
		placedAt: new Date("2026-10-01"),
		customerName: "Ada Lovelace",
		shipCity: "Austin",
		shipRegion: "TX",
		channel: "shopify",
		salesChannel: "Online Store",
		marketplaceOrderId: null,
		externalId: "gid://shopify/Order/1001",
		shipCountry: "US",
		cancelledAt: null,
		fulfillmentStatus: "UNFULFILLED",
		financialStatus: "PAID",
		labelToVoid: false,
		returnStage: null,
		total: 40,
		items: 1,
		unmatched: 0,
		lines: [],
		...over,
	};
}

const chip = (
	field: OrderFilter["field"],
	value: string,
	exclude = false,
): OrderFilter => ({ field, value, exclude, exact: true });

const store = order();
const amazon = order({
	name: "111-222",
	channel: "amazon",
	salesChannel: "Amazon.com",
	marketplaceOrderId: "amazon:111-222",
	items: 2,
});
const relayedTiktok = order({ name: "#1002", salesChannel: "TikTok" });

const find = (
	orders: SearchableOrder[],
	text: string,
	chips: OrderFilter[] = [],
) => {
	const q = parseQuery(text);
	return orders
		.filter((o) => matches(facetsOf(o), [...chips, ...q.filters], q.words))
		.map((o) => o.name);
};

describe("$marketplace", () => {
	const all = [store, amazon, relayedTiktok];

	test("a TikTok sale relayed through Shopify is $tiktok", () => {
		expect(find(all, "", [chip("marketplace", "TikTok")])).toEqual(["#1002"]);
		expect(find(all, "", [chip("marketplace", "Shopify")])).toEqual(["#1001"]);
	});

	test("$! leaves one out, and a word being typed narrows by part", () => {
		expect(find(all, "", [chip("marketplace", "Shopify", true)])).toEqual([
			"111-222",
			"#1002",
		]);
		expect(find(all, "$tik")).toEqual(["#1002"]);
	});

	test("several on one field are alternatives; fields must all match", () => {
		expect(
			find(all, "", [
				chip("marketplace", "Amazon"),
				chip("marketplace", "TikTok"),
			]),
		).toEqual(["111-222", "#1002"]);
		expect(
			find(all, "", [
				chip("marketplace", "Amazon"),
				chip("status", "unfulfilled"),
			]),
		).toEqual([]);
	});
});

describe("%status", () => {
	const fulfilled = order({ name: "#1003", fulfillmentStatus: "FULFILLED" });
	const unknown = order({ name: "#1004", unmatched: 1 });
	const all = [store, amazon, fulfilled, unknown];

	test("one word per badge", () => {
		expect(find(all, "", [chip("status", "unfulfilled")])).toEqual([
			"#1001",
			"#1004",
		]);
		expect(find(all, "", [chip("status", "external")])).toEqual(["111-222"]);
		expect(find(all, "", [chip("status", "fulfilled")])).toEqual(["#1003"]);
		expect(find(all, "", [chip("status", "unmatched")])).toEqual(["#1004"]);
	});

	test("only a real status can be locked in, in any case", () => {
		const typing = parseQuery("%Ext").filters[0];
		expect(lock(typing, "External")).toEqual(chip("status", "external"));
		expect(lock(typing, "nonsense")).toBeNull();
	});

	test("every status is suggested with its badge's words, even unused ones", () => {
		const language = orderLanguage(facetCounts([facetsOf(store)]));
		const typing = parseQuery("%").filters[0];
		const shown = language.suggest(typing, []);
		expect(shown.find((s) => s.value === "returning")).toEqual({
			value: "returning",
			count: 0,
			detail: "Returning",
		});
	});
});

describe("words", () => {
	test("plain words search name, pin, customer, and city", () => {
		const all = [store, amazon];
		expect(find(all, "austin")).toEqual(["#1001", "111-222"]);
		expect(find(all, "111")).toEqual(["111-222"]);
		expect(find(all, "lovelace #1001")).toEqual(["#1001"]);
	});

	test("plain words search line SKUs and titles, and their products'", () => {
		const lines = order({
			name: "#1003",
			lines: [
				{
					title: "Silk Scarf",
					sku: "KAT-42",
					productSku: null,
					productName: null,
				},
				{
					title: "Mug",
					sku: null,
					productSku: "MUG-1",
					productName: "Blue Mug",
				},
			],
		});
		expect(find([lines, store], "kat-42")).toEqual(["#1003"]);
		expect(find([lines, store], "scarf")).toEqual(["#1003"]);
		expect(find([lines, store], "mug-1 blue")).toEqual(["#1003"]);
	});
});

describe("chips in the URL", () => {
	test("unknown statuses and malformed chips are dropped", () => {
		expect(
			chipsFromUrl([
				chip("status", "unfulfilled"),
				chip("status", "gone"),
				chip("marketplace", "eBay", true),
			]),
		).toEqual([
			chip("status", "unfulfilled"),
			chip("marketplace", "eBay", true),
		]);
		expect(chipsFromUrl("nonsense")).toEqual([]);
		expect(chipsFromUrl([{ field: "vendor", value: "x" }])).toEqual([]);
	});
});
