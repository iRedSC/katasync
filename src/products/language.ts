import type { FieldEntry } from "#/components/filter-fields";
import type { SearchLanguage } from "#/components/filter-search";
import {
	type Field,
	type Filter,
	type facetCounts,
	parseWord,
	suggest,
} from "./search";

const LABEL: Record<Field, string> = {
	tag: "tag",
	type: "type",
	vendor: "vendor",
	status: "status",
	class: "class",
	supplier: "supplier",
	trust: "trust",
	title: "title lacks",
	inventory: "inventory",
	velocity: "sold a month",
};

// "not tag", "and vendor", "title lacks": what a chip or suggestion filters on.
function label(f: Pick<Filter, "field" | "exclude" | "and">) {
	const and = f.and ? "and " : "";
	return f.exclude && f.field !== "title"
		? `${and}not ${LABEL[f.field]}`
		: `${and}${LABEL[f.field]}`;
}

// The product search language (search.ts) as the search box speaks it.
export function productLanguage(
	counts: ReturnType<typeof facetCounts>,
): SearchLanguage<Filter> {
	return {
		parse: parseWord,
		suggest: (typing, chips) => suggest(counts, typing, chips, 50),
		// Title exclusions stay "contains": nobody types a whole title.
		lock: (typing, value) => ({
			...typing,
			value,
			exact: typing.field !== "title",
		}),
		label,
		fallback: (typing) =>
			typing.field === "title"
				? `Tab: hide “${typing.value}”`
				: typing.field === "inventory"
					? `Tab: inventory ${typing.value}`
					: typing.field === "velocity"
						? `Tab: ${typing.value} sold a month`
						: `No ${LABEL[typing.field]} “${typing.value}”. Tab to use anyway.`,
		fields: FIELDS,
	};
}

// The filter types, most used first, as the box offers them.
const FIELDS: readonly FieldEntry[] = [
	{ label: "Status", insert: "%", words: ["status"], negatable: true },
	{ label: "Supplier", insert: "&", words: ["supplier"], negatable: true },
	{ label: "Tag", insert: "#", words: ["tag", "tags"], negatable: true },
	{ label: "Vendor", insert: "$", words: ["vendor", "brand"], negatable: true },
	{ label: "Type", insert: "@", words: ["type"], negatable: true },
	{ label: "Class", insert: "*", words: ["class"], negatable: true },
	{ label: "Trust", insert: "~", words: ["trust"], negatable: true },
	{ label: "Stock at most", insert: "<=", words: [], negatable: false },
	{ label: "Stock at least", insert: ">=", words: [], negatable: false },
	{
		label: "Sold a month, at least",
		insert: "v>=",
		words: [],
		negatable: false,
	},
	{
		label: "Title doesn't have",
		insert: "!!",
		words: ["lacks"],
		negatable: false,
	},
];
