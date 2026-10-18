import type { Item } from "./item";
import { isThin } from "./verdict";

export type Show = "loss" | "thin" | "no_cost" | "unsure";
export const SHOWS: [Show, string, (i: Item) => boolean][] = [
	["loss", "Lost money", (i) => i.profit < 0],
	["thin", "Thin margin", isThin],
	["no_cost", "No cost", (i) => !i.costKnown],
	["unsure", "Not final", (i) => !i.complete],
];
