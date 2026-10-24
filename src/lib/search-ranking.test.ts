import { describe, expect, it } from "vitest";
import {
	createSearchIndex,
	matchText,
	normalize,
	type SearchProduct,
	search,
	textMatcher,
} from "./search-ranking";

// Real titles and SKUs from the catalog.
const CATALOG: SearchProduct[] = [
	{
		title: "Drywall Master Flat Box",
		skus: ["DM-05DMFF", "DM-07DMFF"],
		partNumbers: ["05DMFF", "07DMFF"],
	},
	{ title: "Drywall Master Flat Box High Capacity", skus: ["DM-FB10"] },
	{ title: "Drywall Master Flat Box Wiper Seal", skus: ["DM-12FF-37"] },
	{ title: "Drywall Master 180° Flat Box Handle", skus: ["34DMFH-PM180"] },
	{ title: "Flat Box Blades for Drywall Master (5 Pack)", skus: ["DM_FB5"] },
	{ title: "Drywall Master EZRoll Flat Box Wheel Kit", skus: ["KDMF-BB"] },
	{ title: "TapeTech Flat Box", skus: ["TT-EZ07TT"] },
	{ title: "Tapepro Manta-Ray Inside Applicator Head", skus: ["TPRO-AIA"] },
	{
		title: "Makita Cordless Drywall Saw XDS01Z Lithium-Ion (Tool Only)",
		skus: ["MAK-XDS01Z"],
	},
	{ title: "[05-42S] Creaser Arm A", skus: ["WIL-05-42S"] },
	{
		title: 'Mirka Leros 950XCV 9" Electric Sander Full Set',
		skus: ["MIR-MIW95020BAUS-S1"],
		description: "Comes with a dust extractor, hose and sanding discs.",
	},
	{
		title: "Mirka DE-1230 Dust Extractor Bags 5 Pack",
		skus: ["MIR-DE-FDB"],
		description: "Fits the flat box cart.",
	},
];

const index = createSearchIndex(CATALOG);
const titles = (query: string) =>
	search(index, query).map((hit) => hit.item.title);

describe("normalize", () => {
	it("lowercases and turns punctuation and accents into single spaces", () => {
		expect(normalize("  Drywall Master 180° Flat-Box!! ")).toBe(
			"drywall master 180 flat box",
		);
		expect(normalize("Café")).toBe("cafe");
	});
});

describe("search", () => {
	it("ranks the tool above parts that contain its name", () => {
		expect(titles("Drywall Master Flat Box")[0]).toBe(
			"Drywall Master Flat Box",
		);
	});

	it("ranks the tool first despite typos and word order", () => {
		expect(titles("drywal mastr flat box")[0]).toBe("Drywall Master Flat Box");
		expect(titles("flat box drywall master")[0]).toBe(
			"Drywall Master Flat Box",
		);
	});

	it("penalizes extra title characters", () => {
		const ranked = titles("Drywall Master Flat Box");
		expect(ranked.indexOf("Drywall Master Flat Box Wiper Seal")).toBeLessThan(
			ranked.indexOf("Drywall Master Flat Box High Capacity"),
		);
	});

	it("does not assemble a word out of short fragments", () => {
		// "ma" (master) + "kit", "ma" + "ta" (manta).
		expect(titles("makita")).toEqual([
			"Makita Cordless Drywall Saw XDS01Z Lithium-Ion (Tool Only)",
		]);
	});

	it("finds titles while the last word is still being typed", () => {
		expect(titles("fl")).toContain("TapeTech Flat Box");
		expect(titles("tapetech fla")[0]).toBe("TapeTech Flat Box");
	});

	it("puts SKU matches first, ignoring case and punctuation", () => {
		const hits = search(index, "dm-05");
		expect(hits[0]).toMatchObject({
			sku: true,
			item: { title: "Drywall Master Flat Box" },
		});
		expect(search(index, "DM05DMFF")[0].item.title).toBe(
			"Drywall Master Flat Box",
		);
	});

	it("matches manufacturer part numbers like SKUs", () => {
		expect(titles("07dmff")[0]).toBe("Drywall Master Flat Box");
		expect(search(index, "07DMFF")[0]?.sku).toBe(true);
	});

	it("never matches SKUs fuzzily", () => {
		expect(search(index, "dm05dmfx").some((hit) => hit.sku)).toBe(false);
	});

	it("finds products by description, below title matches", () => {
		expect(titles("dust extractor")).toEqual([
			"Mirka DE-1230 Dust Extractor Bags 5 Pack",
			'Mirka Leros 950XCV 9" Electric Sander Full Set',
		]);
	});

	it("caps description matches below good title matches", () => {
		// "flat box" is in the Mirka bags' description only.
		const ranked = titles("flat box");
		expect(ranked.at(-1)).toBe("Mirka DE-1230 Dust Extractor Bags 5 Pack");
	});

	it("returns nothing for a blank query", () => {
		expect(search(index, "  ?! ")).toEqual([]);
	});
});

describe("prefer", () => {
	it("puts the preferred kind first among title matches, after SKUs", () => {
		const isPart = (p: SearchProduct) => p.title.includes("Blades");
		const hits = search(index, "flat box", { prefer: isPart });
		expect(hits[0].item.title).toBe(
			"Flat Box Blades for Drywall Master (5 Pack)",
		);
		expect(search(index, "dm-05", { prefer: isPart })[0].item.title).toBe(
			"Drywall Master Flat Box",
		);
	});
});

describe("textMatcher", () => {
	const row = matchText("#12878 Ana Smith, TapeTech 88TTE taper, Raleigh");
	const finds = (query: string) => textMatcher(query)(row);

	it("finds every word as typed, anywhere, across punctuation", () => {
		expect(finds("878")).toBe(true);
		expect(finds("ana raleigh")).toBe(true);
		expect(finds("88tte")).toBe(true);
	});

	it("forgives a misspelt word, but not a wrong number", () => {
		expect(finds("tapetek")).toBe(true);
		expect(finds("raleiigh")).toBe(true);
		expect(finds("12887")).toBe(false);
		expect(finds("ana boston")).toBe(false);
	});
});
