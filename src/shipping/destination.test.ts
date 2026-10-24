import { expect, test } from "vitest";
import { destinationOf } from "./destination";

const order = (extra = {}) => ({
	channel: "shopify",
	salesChannel: null,
	shipCountry: "US",
	marketplaceOrderId: null,
	...extra,
});

test("a Shippo label tells the channel it was sold on", () => {
	expect(destinationOf(order(), ["shippo"])).toEqual({ kind: "shopify" });
	expect(destinationOf(order({ channel: "ebay" }), ["shippo"])).toEqual({
		kind: "ebay",
	});
});

test("a TikTok label tells TikTok, through Shopify or not", () => {
	expect(
		destinationOf(
			order({ salesChannel: "TikTok", marketplaceOrderId: "tiktok:577" }),
			["tiktok"],
		),
	).toEqual({ kind: "tiktok", orderId: "577", relayed: true });
	expect(
		destinationOf(
			order({ channel: "tiktok", marketplaceOrderId: "tiktok:9" }),
			["tiktok"],
		),
	).toEqual({ kind: "tiktok", orderId: "9", relayed: false });
});

test("labels that don't fit the sale are held", () => {
	const hold = { kind: "hold" };
	expect(
		destinationOf(
			order({ salesChannel: "TikTok", marketplaceOrderId: "tiktok:577" }),
			["shippo"],
		),
	).toMatchObject(hold);
	expect(
		destinationOf(order({ salesChannel: "TikTok" }), ["tiktok"]),
	).toMatchObject(hold);
	expect(destinationOf(order(), ["tiktok"])).toMatchObject(hold);
	expect(destinationOf(order(), ["shippo", "tiktok"])).toMatchObject(hold);
	expect(destinationOf(order({ channel: "amazon" }), ["shippo"])).toMatchObject(
		hold,
	);
	expect(destinationOf(order({ shipCountry: "CA" }), ["shippo"])).toMatchObject(
		hold,
	);
	expect(destinationOf(order(), [])).toMatchObject(hold);
});
