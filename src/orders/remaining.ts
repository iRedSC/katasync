// What's still to ship of an order the marketplace may have partly shipped
// from its own admin. One rule for packing, the order page, To ship, and the
// packing slip. Pure, so the browser can use it too.

// Statuses that say nothing has gone out yet, so a line the channel hasn't
// counted still has all of it to ship. Any other status with an uncounted
// line means some units may be gone and we can't say which.
export const NOTHING_SHIPPED_STATUSES = [
	"UNFULFILLED",
	"ON_HOLD",
	"AWAITING_PAYMENT",
] as const;

const nothingShipped = (status: string) =>
	(NOTHING_SHIPPED_STATUSES as readonly string[]).includes(status);

// What an order's status alone says shipped of a line: all of it once
// fulfilled, none before anything ships, and unknown in between. For
// channels whose own per-line count can be missing.
export function shippedByStatus(fulfillmentStatus: string, quantity: number) {
	if (
		fulfillmentStatus === "FULFILLED" ||
		fulfillmentStatus === "FULFILLMENT_NOT_REQUIRED"
	)
		return quantity;
	return nothingShipped(fulfillmentStatus) ? 0 : null;
}

type Line = { quantity: number; shippedQuantity: number | null };

// Units of a line still to ship, or null when unknown. Shipped is clamped to
// the line's quantity: a channel reporting more shipped than ordered means
// nothing is left, not a negative.
export function unitsToShip(line: Line, fulfillmentStatus: string) {
	if (line.shippedQuantity === null)
		return nothingShipped(fulfillmentStatus) ? line.quantity : null;
	return line.quantity - Math.min(line.shippedQuantity, line.quantity);
}

// Each line with what's left to ship, or unknown when any line with units
// can't say. Lines with nothing left stay in, at 0, for callers that show
// them; packing drops them (toPack).
export type Remaining<L> =
	| { kind: "known"; lines: (L & { toShip: number })[] }
	| { kind: "unknown" };

export function remainingOf<L extends Line>(
	lines: L[],
	fulfillmentStatus: string,
): Remaining<L> {
	const counted: (L & { toShip: number })[] = [];
	for (const line of lines) {
		const toShip = unitsToShip(line, fulfillmentStatus);
		if (toShip === null) {
			if (line.quantity > 0) return { kind: "unknown" };
			continue;
		}
		counted.push({ ...line, toShip });
	}
	return { kind: "known", lines: counted };
}

// The lines to put in the box, each at what's left of it.
export function toPack<L extends Line>(lines: L[], fulfillmentStatus: string) {
	const remaining = remainingOf(lines, fulfillmentStatus);
	if (remaining.kind === "unknown") return null;
	return remaining.lines
		.filter((l) => l.toShip > 0)
		.map(({ toShip, ...line }) => ({ ...line, quantity: toShip }));
}

// Units of a line known to have gone out, at most its quantity.
export const shippedOf = (line: Line) =>
	Math.min(line.shippedQuantity ?? 0, line.quantity);

// Some of the order went out and some didn't: worth showing what's left.
export const partlyShipped = (lines: Line[]) =>
	lines.some((l) => shippedOf(l) > 0) &&
	lines.some((l) => shippedOf(l) < l.quantity);

export const UNKNOWN_REMAINING =
	"the marketplace hasn't said which items already shipped. Ship it there, or wait for the next sync";
