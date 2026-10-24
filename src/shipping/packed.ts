import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	type ContentsDrift,
	dispatches,
	dispatchLines,
	type HandoffHold,
	orderLines,
	products,
} from "#/db/schema";
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

// Every line of these orders with something to pack, as quick ship showed
// it (shipmentPlan).
export async function linesToPack(
	db: Db,
	orderIds: number[],
): Promise<LineToPack[]> {
	return db
		.select({
			orderId: orderLines.orderId,
			orderLineId: orderLines.id,
			lineExternalId: orderLines.externalId,
			productId: orderLines.productId,
			sku: orderLines.sku,
			keySku: sql<string | null>`coalesce(${products.sku}, ${orderLines.sku})`,
			title: orderLines.title,
			quantity: orderLines.quantity,
		})
		.from(orderLines)
		.leftJoin(products, eq(products.id, orderLines.productId))
		.where(
			and(inArray(orderLines.orderId, orderIds), gt(orderLines.quantity, 0)),
		)
		.orderBy(orderLines.orderId, orderLines.id);
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

// Throws ContentsChanged when an order's open lines differ from its box.
export function assertUnchanged(
	packed: Map<string, number>,
	open: Map<string, number>,
	titles: Map<string, string>,
) {
	const drift = driftOf(packed, open, titles);
	if (drift.length > 0) throw new ContentsChanged(drift);
}
