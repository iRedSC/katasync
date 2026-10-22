import { expect, test } from "vitest";
import { type Candidate, rankCandidates } from "./match-rank";

const product = (
	productId: number,
	sku: string,
	name: string,
	extra: Partial<Candidate> = {},
): Candidate => ({
	productId,
	sku,
	name,
	variantName: null,
	kind: "simple",
	codes: [],
	...extra,
});

const catalog = [
	product(1, "ROCK-SPL", "Rock Splicer"),
	product(2, "MR-GAS", "Mud Runner Gas Spring", { codes: ["149020"] }),
	product(3, "TT-SET", "Taper Set", { kind: "bundle" }),
	product(4, "CF-4", "Carbon Fiber Blade", { variantName: "4 inch" }),
];

const rank = (
	title: string,
	extra: Partial<Parameters<typeof rankCandidates>[0]> = {},
) =>
	rankCandidates(
		{ title, sku: null, matchedBefore: [], fba: false, ...extra },
		catalog,
	).map((r) => [r.candidate.sku, r.reason]);

test("spacing doesn't hide a product", () => {
	const r = rankCandidates(
		{ title: "Rock Splicer", sku: null, matchedBefore: [], fba: false },
		[product(9, "ROCKSPLICER", "Rocksplicer Backing Board (10 Pack)")],
	);
	expect(r.map((x) => x.reason)).toEqual(["part-number"]);
});

test("a listing's SKU matching a product's code beats a similar name", () => {
	expect(rank("Taper", { sku: "149020" })[0]).toEqual(["MR-GAS", "same-sku"]);
});

test("a supplier part number inside the title finds the product", () => {
	expect(rank("149020 Pressurized gas cylinder")).toEqual([
		["MR-GAS", "part-number"],
	]);
});

test("a part number must be a whole word", () => {
	expect(rank("1490201 gas cylinder")).toEqual([]);
});

test("the same name ignores case, punctuation, and Shopify's Default Title", () => {
	expect(rank("ROCK splicer - Default Title")).toEqual([
		["ROCK-SPL", "same-name"],
	]);
});

test("a variant name counts as part of the product's name", () => {
	expect(rank("Carbon Fiber Blade 4 Inch")[0]).toEqual(["CF-4", "same-name"]);
});

test("a title matched elsewhere suggests the same product first", () => {
	expect(rank("Something else", { matchedBefore: [4] })).toEqual([
		["CF-4", "matched-before"],
	]);
});

test("FBA listings are never offered a tool set", () => {
	expect(rank("Taper Set", { fba: true })).toEqual([]);
	expect(rank("Taper Set")).toEqual([["TT-SET", "same-name"]]);
});
