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
		suggest: (typing, chips) => suggest(counts, typing, chips),
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
	};
}
