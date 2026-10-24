import { describe, expect, test } from "vitest";
import type { Day } from "#/lib/period";
import { type OrderFilter, orderSearch, type SearchableOrder } from "./search";

const { chipsFromUrl, parseQuery } = orderSearch;

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
		fulfilledByChannel: false,
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

const on = "2026-10-24" as Day;
const find = (
	orders: SearchableOrder[],
	text: string,
	chips: OrderFilter[] = [],
) => {
	const q = parseQuery(text);
	const idx = orderSearch.index(orders, on);
	return orderSearch
		.filter(orders, idx, [...chips, ...q.filters], q.words, on)
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
		expect(orderSearch.lock(typing, "External")).toEqual(
			chip("status", "external"),
		);
		expect(orderSearch.lock(typing, "nonsense")).toBeNull();
	});

	test("every status is suggested with its badge's words, even unused ones", () => {
		const idx = orderSearch.index([store], on);
		const typing = parseQuery("%").filters[0];
		const shown = orderSearch.suggest(idx, typing, []);
		expect(shown.find((s) => s.value === "fba")).toEqual({
			value: "fba",
			count: 0,
			detail: "FBA Fulfilled",
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

describe("~placed", () => {
	const early = order({ name: "#1", placedAt: new Date("2026-10-01T16:00Z") });
	// 11 PM in New York on the 23rd is already the 24th in UTC.
	const late = order({ name: "#2", placedAt: new Date("2026-10-24T03:00Z") });
	const now = order({ name: "#3", placedAt: new Date("2026-10-24T15:00Z") });
	const all = [early, late, now];

	test("named ranges count in the shop's days", () => {
		expect(find(all, "", [chip("placed", "today")])).toEqual(["#3"]);
		expect(find(all, "", [chip("placed", "yesterday")])).toEqual(["#2"]);
	});

	test("picked days include both ends, and either can be open", () => {
		expect(find(all, "", [chip("placed", "2026-10-01..2026-10-23")])).toEqual([
			"#1",
			"#2",
		]);
		expect(find(all, "", [chip("placed", "2026-10-02..")])).toEqual([
			"#2",
			"#3",
		]);
		expect(find(all, "", [chip("placed", "..2026-10-01")])).toEqual(["#1"]);
	});

	test("one period at a time, and all time is no chip", () => {
		const a = orderSearch.add([], chip("placed", "today"));
		const b = orderSearch.add(a, chip("placed", "last_week"));
		expect(b).toEqual([chip("placed", "last_week")]);
		expect(orderSearch.add(b, chip("placed", ".."))).toEqual([]);
	});

	test("a period locks in only when it is one", () => {
		const typing = parseQuery("~").filters[0];
		expect(orderSearch.lock(typing, "2026-10-15..2026-10-01")?.value).toBe(
			"2026-10-01..2026-10-15",
		);
		expect(orderSearch.lock(typing, "2026-02-30..")).toBeNull();
		expect(orderSearch.lock(typing, "soon")).toBeNull();
	});
});
