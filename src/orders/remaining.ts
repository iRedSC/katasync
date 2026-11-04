// What's still to ship of an order the marketplace may have partly shipped
// from its own admin. One rule for packing, the order page, To ship, and the
// packing slip. Pure, so the browser can use it too.

// Statuses that guarantee nothing has gone out yet. AWAITING_PAYMENT is
// only ever a sale not yet paid for (Amazon's Pending, TikTok's UNPAID),
// which can't ship. ON_HOLD isn't one: Shopify's describes the items not yet
// shipped, so an order can hold some and have shipped the rest.
const NOTHING_SHIPPED_STATUSES = ["UNFULFILLED", "AWAITING_PAYMENT"];

// What a marketplace's own order status alone says shipped of a line: all of
// it once fulfilled, none when nothing can have shipped, and unknown
// otherwise. Only for channel adapters at sync time, where the status is the
// marketplace's. Never for a saved order: katasync rewrites its status
// locally (a void puts it back to UNFULFILLED), so it no longer says what
// the marketplace shipped.
export function shippedByStatus(fulfillmentStatus: string, quantity: number) {
	if (
		fulfillmentStatus === "FULFILLED" ||
		fulfillmentStatus === "FULFILLMENT_NOT_REQUIRED"
	)
		return quantity;
	return NOTHING_SHIPPED_STATUSES.includes(fulfillmentStatus) ? 0 : null;
}

type Line = { quantity: number; shippedQuantity: number | null };

// Units of a line still to ship, or null when the marketplace hasn't said
// what shipped of it. Shipped is clamped to the line's quantity: a channel
// reporting more shipped than ordered means nothing is left, not a negative.
export function unitsToShip(line: Line) {
	if (line.shippedQuantity === null) return null;
	return line.quantity - Math.min(line.shippedQuantity, line.quantity);
}

// Each line with what's left to ship, or unknown when any line with units
// can't say. Lines with nothing left stay in, at 0, for callers that show
// them; packing drops them (toPack).
export type Remaining<L> =
	| { kind: "known"; lines: (L & { toShip: number })[] }
	| { kind: "unknown" };

export function remainingOf<L extends Line>(lines: L[]): Remaining<L> {
	const counted: (L & { toShip: number })[] = [];
	for (const line of lines) {
		const toShip = unitsToShip(line);
		if (toShip === null) {
			if (line.quantity > 0) return { kind: "unknown" };
			continue;
		}
		counted.push({ ...line, toShip });
	}
	return { kind: "known", lines: counted };
}

// The lines to put in the box, each at what's left of it, or null when
// what's left is unknown.
export function toPack<L extends Line>(lines: L[]) {
	const remaining = remainingOf(lines);
	if (remaining.kind === "unknown") return null;
	return remaining.lines
		.filter((l) => l.toShip > 0)
		.map(({ toShip, ...line }) => ({ ...line, quantity: toShip }));
}

// What a packing slip says to put in the box per line. An order with a live
// label not handed off yet prints that box's contents (unsent: its dispatch
// lines; one such dispatch at most, and every order in it has a line), so a
// reprint shows what's in the box. Otherwise what's left, for an order still
// to pack whose marketplace has said what shipped; anything else (finished,
// cancelled, or unknown) prints what was sold. quantity stays what was sold
// either way, for the money.
export function toPrint<L extends Line & { unsent: number }>(
	lines: L[],
	order: { needsPacking: boolean },
): (L & { toPack: number })[] {
	if (lines.some((l) => l.unsent > 0))
		return lines.map((l) => ({ ...l, toPack: l.unsent }));
	const known = order.needsPacking && remainingOf(lines).kind === "known";
	return lines.map((l) => ({
		...l,
		toPack: known ? (unitsToShip(l) ?? l.quantity) : l.quantity,
	}));
}

// Units of a line known to have gone out, at most its quantity, or null when
// the marketplace hasn't said.
export const shippedOf = (line: Line) =>
	line.shippedQuantity === null
		? null
		: Math.min(line.shippedQuantity, line.quantity);

// Some of the order is known to have gone out and some known not to: worth
// showing what's left. A line whose count is unknown is neither.
export function partlyShipped(lines: Line[]) {
	const shipped = lines.flatMap((l) => {
		const s = shippedOf(l);
		return s === null ? [] : [{ shipped: s, quantity: l.quantity }];
	});
	return (
		shipped.some((l) => l.shipped > 0) &&
		shipped.some((l) => l.shipped < l.quantity)
	);
}

export const UNKNOWN_REMAINING =
	"the marketplace hasn't said which items already shipped. Ship it there, or wait for the next sync";
