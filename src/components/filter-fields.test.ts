import { describe, expect, it } from "vitest";
import { expandAlias, type FieldEntry, matchFields } from "./filter-fields";

const FIELDS: FieldEntry[] = [
	{ label: "Tag", insert: "#", words: ["tag", "tags"], negatable: true },
	{ label: "Vendor", insert: "$", words: ["vendor"], negatable: true },
	{ label: "Title", insert: "!!", words: ["lacks"], negatable: false },
];

describe("expandAlias", () => {
	it("turns a field word into its sigil", () => {
		expect(expandAlias(FIELDS, "tag ")).toBe("#");
		expect(expandAlias(FIELDS, "box Vendor ")).toBe("box $");
	});

	it("negates with not before or after", () => {
		expect(expandAlias(FIELDS, "not tag ")).toBe("#!");
		expect(expandAlias(FIELDS, "box not tag ")).toBe("box #!");
		expect(expandAlias(FIELDS, "#not ")).toBe("#!");
	});

	it("leaves not alone where it can't negate", () => {
		expect(expandAlias(FIELDS, "not lacks ")).toBe("not !!");
	});

	it("leaves plain words and words inside others alone", () => {
		expect(expandAlias(FIELDS, "taping ")).toBeNull();
		expect(expandAlias(FIELDS, "stag ")).toBeNull();
		expect(expandAlias(FIELDS, "tag")).toBeNull();
	});
});

describe("matchFields", () => {
	it("offers everything for nothing typed, nothing for one letter", () => {
		expect(matchFields(FIELDS, "")).toHaveLength(3);
		expect(matchFields(FIELDS, "t")).toEqual([]);
		expect(matchFields(FIELDS, "ve").map((f) => f.label)).toEqual(["Vendor"]);
	});
});
