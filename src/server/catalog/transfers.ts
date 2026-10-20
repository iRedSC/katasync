import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { getDb } from "#/db/client";
import { products } from "#/db/schema";
import { transferStock } from "#/inventory/ledger";

// Moves stock between our shelves, e.g. restocking the retail store.
export const recordTransfer = createServerFn({ method: "POST" })
	.validator(
		type({
			sku: "string > 0",
			fromLocationId: "number.integer > 0",
			toLocationId: "number.integer > 0",
			quantity: "number.integer > 0",
			"note?": "string",
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const [product] = await db
			.select({ id: products.id })
			.from(products)
			.where(eq(products.sku, data.sku));
		if (!product) throw new Error(`No product ${data.sku}`);
		const { batchId } = await transferStock(db, {
			productId: product.id,
			fromLocationId: data.fromLocationId,
			toLocationId: data.toLocationId,
			quantity: data.quantity,
			note: data.note,
		});
		return { batchId };
	});
