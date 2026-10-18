import { type Item, margin } from "./item";

// Made money, but so little a small surprise turns it into a loss.
const THIN_MARGIN = 0.05;
const THIN_PROFIT = 3;
export const isThin = (i: Item) =>
	i.profit >= 0 && (i.profit < THIN_PROFIT || (margin(i) ?? 0) < THIN_MARGIN);
// Made enough on one sale to stand out.
const GREAT_PROFIT = 100;

// How a sale did, at a glance: its row's color. A sale with no cost has a
// profit that's too high, so it gets no verdict.
export const VERDICT = {
	loss: { row: "bg-critical-surface", text: "text-critical-text" },
	thin: { row: "bg-warning-surface", text: "text-warning-text" },
	great: { row: "bg-success-surface/50", text: "text-success-text" },
} as const;
export function verdict(i: Item): keyof typeof VERDICT | null {
	if (!i.costKnown) return null;
	if (i.profit < 0) return "loss";
	if (isThin(i)) return "thin";
	if (i.profit >= GREAT_PROFIT) return "great";
	return null;
}
