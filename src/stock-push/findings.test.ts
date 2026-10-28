import { expect, test } from "vitest";
import { unpushableFinding } from "./findings";

test("a standing fact about the listing is excluded, not a problem", () => {
	expect(
		unpushableFinding("WRENCH", "Shopify", {
			state: "unpushable",
			reason: "Shopify doesn't track this variant's inventory",
			byDesign: true,
		}),
	).toEqual({ kind: "excluded" });
});

test("anything else it can't set is a problem naming the SKU and why", () => {
	expect(
		unpushableFinding("WRENCH", "TikTok", {
			state: "unpushable",
			reason: "TikTok shows it in no sales warehouse",
		}),
	).toEqual({
		kind: "problem",
		text: "WRENCH: katasync can't set its TikTok stock: TikTok shows it in no sales warehouse",
	});
});
