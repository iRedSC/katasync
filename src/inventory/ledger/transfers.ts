import { inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, products } from "#/db/schema";
import { ourKinds } from "#/inventory/locations";
import { assertPositiveInteger, LedgerError, postMovements } from "./post";

// Moves stock from one of our shelves to another, e.g. restocking the retail
// store from the warehouse. Every line is one batch, so undoing it moves the
// stock back. Refused, changing nothing, when the shelf it leaves doesn't
// hold that many of any line: a shelf that's off should be counted, not
// carried below zero.
export async function transferStock(
	db: Db,
	input: {
		fromLocationId: number;
		toLocationId: number;
		lines: { productId: number; quantity: number }[];
		reference?: string;
		note?: string;
	},
) {
	if (input.lines.length === 0) throw new LedgerError("Nothing to move");
	for (const line of input.lines) assertPositiveInteger(line.quantity);
	if (input.fromLocationId === input.toLocationId)
		throw new LedgerError("Pick two different locations");
	return db.transaction(async (tx) => {
		const ends = await tx
			.select({ id: locations.id, name: locations.name, kind: locations.kind })
			.from(locations)
			.where(inArray(locations.id, [input.fromLocationId, input.toLocationId]));
		const from = ends.find((l) => l.id === input.fromLocationId);
		const to = ends.find((l) => l.id === input.toLocationId);
		for (const end of [from, to])
			if (!end || !(ourKinds as readonly string[]).includes(end.kind))
				throw new LedgerError("Stock moves only between our own locations");
		const result = await postMovements(tx, {
			reference: input.reference ?? "transfer",
			note: input.note?.trim() || undefined,
			lines: input.lines.flatMap((line) => [
				{
					productId: line.productId,
					locationId: input.fromLocationId,
					delta: -line.quantity,
					reason: "transfer_out" as const,
				},
				{
					productId: line.productId,
					locationId: input.toLocationId,
					delta: line.quantity,
					reason: "transfer_in" as const,
				},
			]),
		});
		const short = input.lines.flatMap((line) => {
			const left = result.levels.find(
				(l) =>
					l.productId === line.productId &&
					l.locationId === input.fromLocationId,
			);
			return left && left.onHand < 0
				? [{ ...line, had: Math.max(0, left.onHand + line.quantity) }]
				: [];
		});
		if (short.length > 0) {
			const skus = await tx
				.select({ id: products.id, sku: products.sku })
				.from(products)
				.where(
					inArray(
						products.id,
						short.map((s) => s.productId),
					),
				);
			const sku = (id: number) => skus.find((s) => s.id === id)?.sku;
			throw new LedgerError(
				`${short.map((s) => `${from?.name} has ${s.had} of ${sku(s.productId)}, not ${s.quantity}`).join("; ")}. Count it there if that's wrong.`,
			);
		}
		return result;
	});
}
