import { inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations } from "#/db/schema";
import { ourKinds } from "#/inventory/locations";
import {
	assertPositiveInteger,
	getProduct,
	LedgerError,
	postMovements,
} from "./post";

// Moves stock from one of our shelves to another, e.g. restocking the retail
// store from the warehouse. Both sides are one batch, so undoing it moves the
// stock back. Refused when the shelf it leaves doesn't hold that many: a
// shelf that's off should be counted, not carried below zero.
export async function transferStock(
	db: Db,
	input: {
		productId: number;
		fromLocationId: number;
		toLocationId: number;
		quantity: number;
		note?: string;
	},
) {
	assertPositiveInteger(input.quantity);
	if (input.fromLocationId === input.toLocationId)
		throw new LedgerError("Pick two different locations");
	return db.transaction(async (tx) => {
		const product = await getProduct(tx, input.productId);
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
			reference: "transfer",
			note: input.note?.trim() || undefined,
			lines: [
				{
					productId: product.id,
					locationId: input.fromLocationId,
					delta: -input.quantity,
					reason: "transfer_out",
				},
				{
					productId: product.id,
					locationId: input.toLocationId,
					delta: input.quantity,
					reason: "transfer_in",
				},
			],
		});
		const left = result.levels.find(
			(l) => l.locationId === input.fromLocationId,
		);
		if (left && left.onHand < 0) {
			const had = left.onHand + input.quantity;
			throw new LedgerError(
				`${from?.name} has ${Math.max(0, had)} of ${product.sku}, not ${input.quantity}. Count it there if that's wrong.`,
			);
		}
		return result;
	});
}
