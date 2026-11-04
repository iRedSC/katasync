import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	type ContentsDrift,
	dispatches,
	dispatchLines,
	type HandoffHold,
	orderLines,
	orders,
	products,
} from "#/db/schema";
import { groupBy } from "#/lib/group-by";
import { toPack, whyNotPackable } from "#/orders/remaining";
import { unitsHandedOff, unitsUnsent } from "#/orders/to-ship";
import { contentsKey } from "./contents";

// What went in a dispatch's boxes, kept when its labels are bought
// (dispatch_lines in schema.ts) and checked against the order again before
// any marketplace is told it shipped.

export type PackedLine = Omit<
	typeof dispatchLines.$inferSelect,
	"dispatchId" | "orderLineId"
> & { orderLineId?: number | null };

// What katasync knows a dispatch held. unknown: bought before contents were
// kept, so nothing about its lines may be assumed.
export type Contents =
	| { kind: "packed"; lines: PackedLine[] }
	| { kind: "unknown" };

// A line to pack, with the SKU quick ship keys its contents by (the
// product's, else the channel's) beside the channel's own, which is kept.
export type LineToPack = PackedLine & { keySku: string | null };

// Lines staff lowered from all that's packable: how many of each go now,
// by order line. Any line not named ships everything packable; 0 leaves it
// out, for a later shipment.
export type Lowered = { orderLineId: number; quantity: number }[];

// The lines with their chosen counts, without the ones set to 0, and the
// orders sending less than all that's packable (TikTok refuses those).
// Throws for a count that isn't a whole number from 0 to what's packable,
// or a line that has nothing packable here.
export function choose<
	L extends { orderId: number; orderLineId?: number | null; quantity: number },
>(packable: L[], lowered: Lowered): { lines: L[]; partial: number[] } {
	const counts = new Map<number, number>();
	for (const l of lowered) {
		if (counts.has(l.orderLineId)) throw new Error("A line was chosen twice");
		const line = packable.find((p) => p.orderLineId === l.orderLineId);
		if (!line) throw new Error("A chosen line has nothing left to pack");
		if (
			!Number.isInteger(l.quantity) ||
			l.quantity < 0 ||
			l.quantity > line.quantity
		)
			throw new Error(`Only ${line.quantity} of a line can be packed`);
		counts.set(l.orderLineId, l.quantity);
	}
	const partial = new Set<number>();
	const lines = packable.flatMap((l) => {
		const chosen =
			l.orderLineId == null ? undefined : counts.get(l.orderLineId);
		const quantity = chosen ?? l.quantity;
		if (quantity < l.quantity) partial.add(l.orderId);
		return quantity > 0 ? [{ ...l, quantity }] : [];
	});
	return { lines, partial: [...partial] };
}

// Every line of these orders with something packable, at what's packable
// (src/orders/remaining.ts), as quick ship showed it (shipmentPlan). Throws
// for an order whose remaining isn't known, which whyNotTogether refuses
// first.
export async function packableLines(
	db: Db,
	orderIds: number[],
): Promise<LineToPack[]> {
	const rows = await db
		.select({
			orderId: orderLines.orderId,
			orderLineId: orderLines.id,
			lineExternalId: orderLines.externalId,
			productId: orderLines.productId,
			sku: orderLines.sku,
			keySku: sql<string | null>`coalesce(${products.sku}, ${orderLines.sku})`,
			title: orderLines.title,
			quantity: orderLines.quantity,
			shippedQuantity: orderLines.shippedQuantity,
			handedOff: unitsHandedOff,
			unsent: unitsUnsent,
			orderName: orders.name,
		})
		.from(orderLines)
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.leftJoin(products, eq(products.id, orderLines.productId))
		.where(
			and(inArray(orderLines.orderId, orderIds), gt(orderLines.quantity, 0)),
		)
		.orderBy(orderLines.orderId, orderLines.id);
	return [...groupBy(rows, (r) => r.orderId).values()].flatMap((lines) => {
		const packing = toPack(lines);
		if (packing.kind !== "known")
			throw new Error(`${lines[0].orderName}: ${whyNotPackable(packing.kind)}`);
		return packing.lines.map(
			({ shippedQuantity, handedOff, unsent, orderName, ...line }) => line,
		);
	});
}

// Stops a purchase when the orders no longer hold what was on screen when
// the box was packed.
export function assertAsPacked(lines: LineToPack[], shown: string) {
	if (lines.length === 0) throw new Error("Nothing on these orders to pack");
	if (contentsKey(lines.map((l) => ({ ...l, sku: l.keySku }))) !== shown) {
		throw new Error(
			"The order changed since it was packed. Look it up again and repack.",
		);
	}
}

export async function contentsOf(
	db: Db,
	dispatchId: number,
): Promise<Contents> {
	const [dispatch] = await db
		.select({ contents: dispatches.contents })
		.from(dispatches)
		.where(eq(dispatches.id, dispatchId));
	if (!dispatch) throw new Error(`No dispatch ${dispatchId}`);
	if (dispatch.contents === "unknown") return { kind: "unknown" };
	const lines = await db
		.select({
			orderId: dispatchLines.orderId,
			orderLineId: dispatchLines.orderLineId,
			lineExternalId: dispatchLines.lineExternalId,
			productId: dispatchLines.productId,
			sku: dispatchLines.sku,
			title: dispatchLines.title,
			quantity: dispatchLines.quantity,
		})
		.from(dispatchLines)
		.where(eq(dispatchLines.dispatchId, dispatchId))
		.orderBy(dispatchLines.orderId, dispatchLines.lineExternalId);
	return { kind: "packed", lines };
}

// One order's packed lines.
export const packedOf = (lines: PackedLine[], orderId: number) =>
	lines.filter((l) => l.orderId === orderId);

// Packed quantities by the channel's line id.
export const byLine = (lines: PackedLine[]) =>
	new Map(lines.map((l) => [l.lineExternalId, l.quantity]));

// Packed quantities by some other key, or null when a line has none, so it
// can't be matched.
export function byKey(
	lines: PackedLine[],
	keyOf: (line: PackedLine) => string | null,
): Map<string, number> | null {
	const totals = new Map<string, number>();
	for (const line of lines) {
		const key = keyOf(line);
		if (!key) return null;
		totals.set(key, (totals.get(key) ?? 0) + line.quantity);
	}
	return totals;
}

// The lines whose packed and open quantities differ, any line missing from
// one side counting as 0 there. Empty means the box is exactly what's open.
export function driftOf(
	packed: Map<string, number>,
	open: Map<string, number>,
	titles: Map<string, string>,
): ContentsDrift {
	const lines = [...new Set([...packed.keys(), ...open.keys()])].sort();
	return lines.flatMap((line) => {
		const p = packed.get(line) ?? 0;
		const o = open.get(line) ?? 0;
		return p === o
			? []
			: [{ line, title: titles.get(line) ?? line, packed: p, open: o }];
	});
}

// A handoff that mustn't go out: telling the marketplace now could ship
// something other than the box. Held, not retried, until checking again
// finds it matching, or the labels are voided.
export class Held extends Error {
	constructor(
		readonly hold: HandoffHold,
		message: string,
	) {
		super(message);
	}
}

export class ContentsChanged extends Held {
	constructor(readonly drift: ContentsDrift) {
		super(
			{ kind: "drift", drift },
			`The order changed since it was packed (${drift
				.map((d) => `${d.title}: packed ${d.packed}, now ${d.open}`)
				.join("; ")}). Check again once it's fixed, or void and repack`,
		);
	}
}

export const unmappable = (why: string) =>
	new Held({ kind: "unmappable", why }, why);

// How a box must match what the marketplace has open. exactly: everything
// open is in the box, nothing more (a drop-ship sends the whole order).
// within: every packed line is still open with at least its packed
// quantity; open units beyond the box, and lines not in it, are the rest of
// the order, left for a later shipment.
export type Fit = "exactly" | "within";

// The packed lines the marketplace no longer has enough of open.
export function shortOf(
	packed: Map<string, number>,
	open: Map<string, number>,
	titles: Map<string, string>,
): ContentsDrift {
	return [...packed.keys()].sort().flatMap((line) => {
		const p = packed.get(line) ?? 0;
		const o = open.get(line) ?? 0;
		return o >= p
			? []
			: [{ line, title: titles.get(line) ?? line, packed: p, open: o }];
	});
}

// Throws ContentsChanged when the box doesn't fit what's open.
export function assertFits(
	fit: Fit,
	packed: Map<string, number>,
	open: Map<string, number>,
	titles: Map<string, string>,
) {
	const drift =
		fit === "exactly"
			? driftOf(packed, open, titles)
			: shortOf(packed, open, titles);
	if (drift.length > 0) throw new ContentsChanged(drift);
}
