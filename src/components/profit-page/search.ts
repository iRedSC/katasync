import { type Chip, defineSearch } from "#/lib/facet-search";
import { channelName } from "#/lib/format";
import type { Item } from "./item";
import { isThin } from "./verdict";

// What an item can be flagged for, each a word to filter on.
const FLAGS: [string, (i: Item) => boolean, string][] = [
	["lost money", (i) => i.profit < 0, "Made less than nothing"],
	["thin", isThin, "Thin margin"],
	["no cost", (i) => !i.costKnown, "Its product has no cost yet"],
	["not final", (i) => !i.complete, "Fees or labels still to come"],
	["rebilled", (i) => i.postageAdjusted, "A carrier adjusted the postage"],
];

// The profit list's search. ~ is the period sold, which the page loads by
// rather than filtering what's loaded.
export const profitSearch = defineSearch<Item, "sold" | "channel" | "flag">({
	fields: {
		sold: {
			kind: "period",
			sigil: "~",
			label: "sold",
			menu: "Sold",
			words: ["sold", "date", "when", "time"],
			at: null,
		},
		flag: {
			kind: "values",
			sigil: "%",
			label: "flag",
			menu: "Flag",
			words: ["flag", "flagged", "status"],
			of: (i) => FLAGS.filter(([, test]) => test(i)).map(([word]) => word),
			known: FLAGS.map(([word]) => word),
			details: new Map(FLAGS.map(([word, , detail]) => [word, detail])),
			closed: true,
		},
		channel: {
			kind: "values",
			sigil: "$",
			label: "sold on",
			menu: "Marketplace",
			words: ["marketplace", "channel"],
			of: (i) => channelName(i.soldOn),
		},
	},
	text: (i) => [i.sku, i.name, i.variantName, i.orderName],
});

export type ProfitChip = Chip<"sold" | "channel" | "flag">;
