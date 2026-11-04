// What's still to ship of an order the marketplace or katasync may have
// partly shipped. One rule for packing, the order page, To ship, and the
// packing slip; drizzle/0182 holds the database to the same. Pure, so the
// browser can use it too.

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

// What katasync itself holds of a line, from its dispatches
// (src/orders/to-ship.ts reads both): units handed off to the marketplace
// and not taken back, and units in live dispatches not handed off yet.
export type Dispatched = { handedOff: number; unsent: number };

type PackLine = Line & Dispatched;

// Units of a line that can go in a new box: what the marketplace says is
// left, less what a live dispatch already holds. Unknown when the
// marketplace hasn't said; behind when its count doesn't yet cover what
// katasync handed off, so it predates that handoff and the next sync (seconds
// for webhooks) brings it up to date. Shipped is clamped to the line's
// quantity: a channel reporting more shipped than ordered means nothing is
// left, not a negative.
export type Packable =
	| { kind: "known"; units: number }
	| { kind: "unknown" }
	| { kind: "behind" };

export function packableOf(line: PackLine): Packable {
	if (line.shippedQuantity === null) return { kind: "unknown" };
	if (line.shippedQuantity < line.handedOff) return { kind: "behind" };
	const left = line.quantity - Math.min(line.shippedQuantity, line.quantity);
	return { kind: "known", units: Math.max(0, left - line.unsent) };
}

// Each line with what can be packed of it, or why not when any line with
// units can't say. Lines with nothing packable stay in, at 0, for callers
// that show them; packing drops them (toPack). Unknown wins over behind:
// it's the one that may need a person.
export type Remaining<L> =
	| { kind: "known"; lines: (L & { toShip: number })[] }
	| { kind: "unknown" }
	| { kind: "behind" };

export function remainingOf<L extends PackLine>(lines: L[]): Remaining<L> {
	const counted: (L & { toShip: number })[] = [];
	let behind = false;
	for (const line of lines) {
		const packable = packableOf(line);
		if (packable.kind !== "known") {
			if (line.quantity === 0) continue;
			if (packable.kind === "unknown") return { kind: "unknown" };
			behind = true;
			continue;
		}
		counted.push({ ...line, toShip: packable.units });
	}
	return behind ? { kind: "behind" } : { kind: "known", lines: counted };
}

// The lines to put in the box, each at what can be packed of it, or why
// that isn't known.
export function toPack<L extends PackLine>(
	lines: L[],
): { kind: "known"; lines: L[] } | { kind: "unknown" } | { kind: "behind" } {
	const remaining = remainingOf(lines);
	if (remaining.kind !== "known") return remaining;
	return {
		kind: "known",
		lines: remaining.lines
			.filter((l) => l.toShip > 0)
			.map(
				({ toShip, ...line }) =>
					({ ...line, quantity: toShip }) as unknown as L,
			),
	};
}

// Why an order's lines can't be packed yet, for a person.
export const whyNotPackable = (kind: "unknown" | "behind") =>
	kind === "unknown" ? UNKNOWN_REMAINING : BEHIND_REMAINING;

// What a packing slip says to put in the box per line: what can be packed,
// for an order still to pack whose count is known. Anything else (finished,
// cancelled, a reprint, or unknown) prints what was sold. quantity stays
// what was sold either way, for the money.
export function toPrint<L extends PackLine>(
	lines: L[],
	order: { needsPacking: boolean },
): (L & { toPack: number })[] {
	const known = order.needsPacking && remainingOf(lines).kind === "known";
	return lines.map((l) => {
		const packable = packableOf(l);
		return {
			...l,
			toPack: known && packable.kind === "known" ? packable.units : l.quantity,
		};
	});
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

export const BEHIND_REMAINING =
	"waiting for the marketplace to catch up with the last shipment. Try again in a moment";
