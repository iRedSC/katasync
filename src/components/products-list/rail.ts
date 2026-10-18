import type { RailGroup } from "#/components/facet-rail";

// The rail's groups, in the order a reorder pass goes: what's wrong, whether
// the number can be trusted, whether it's worth it, then who sells it.
export const RAIL: RailGroup[] = [
	{
		title: "Stock",
		field: "status",
		values: [
			"needs ordering",
			"below min",
			"oversold",
			"sold out",
			"missing parts",
			"over max",
			"on order",
			"on a draft",
		],
	},
	{
		title: "Trust",
		field: "trust",
		values: ["counted", "uncounted"],
	},
	{
		title: "Class",
		field: "class",
		values: ["A", "B", "C"],
		label: (v) => `${v} items`,
	},
	{ title: "Velocity", field: "velocity", range: true },
	{ title: "Supplier", field: "supplier", values: null },
	{ title: "Type", field: "type", values: null },
];
