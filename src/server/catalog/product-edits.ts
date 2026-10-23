import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { getDb } from "#/db/client";
import { locations } from "#/db/schema";
import { assembleKits, disassembleKits, LedgerError } from "#/inventory/ledger";
import { isOurs } from "#/inventory/locations";
import { setRecipe } from "#/inventory/recipes";
import { deleteProduct } from "#/products/archive";
import { ProductError, updateProductDetails } from "#/products/details";

// What staff change about a product on its page. Each calls the same core
// function as Claude's tool for it, so the checks and refusals are the same.

// Only the given fields change; null clears one (src/products/details.ts).
export const updateProduct = createServerFn({ method: "POST" })
	.validator(
		type({
			productId: "number.integer > 0",
			"name?": "string > 0",
			"variantName?": "string | null",
			"category?": "string | null",
			"barcode?": "string | null",
			"unitCost?": "number >= 0 | null",
			// When the cost was set, for undo putting an earlier one back.
			"unitCostSetAt?": "string.date.iso",
			"weightOz?": "number > 0 | null",
			"lengthIn?": "number > 0 | null",
			"widthIn?": "number > 0 | null",
			"heightIn?": "number > 0 | null",
		}),
	)
	.handler(async ({ data: { productId, unitCostSetAt, ...details } }) => {
		const { unitCost } = details;
		if (unitCostSetAt === undefined)
			await updateProductDetails(getDb(), productId, details);
		else if (typeof unitCost === "number")
			await updateProductDetails(getDb(), productId, {
				...details,
				unitCost,
				unitCostSetAt: new Date(unitCostSetAt),
			});
		else throw new ProductError("A cost's date needs the cost with it");
	});

// Replaces what a kit or tool set is made of, the whole list at once.
export const setProductParts = createServerFn({ method: "POST" })
	.validator(
		type({
			productId: "number.integer > 0",
			parts: type({
				productId: "number.integer > 0",
				quantity: "number.integer > 0",
			})
				.array()
				.atLeastLength(1),
		}),
	)
	.handler(async ({ data }) => {
		await setRecipe(getDb(), data.productId, data.parts);
	});

// Builds kits from their parts on one of our shelves, or takes them apart.
// Returns the batch, for undo.
export const convertKits = createServerFn({ method: "POST" })
	.validator(
		type({
			productId: "number.integer > 0",
			direction: "'assemble' | 'disassemble'",
			quantity: "number.integer > 0",
			locationId: "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const [ours] = await db
			.select({ id: locations.id })
			.from(locations)
			.where(and(eq(locations.id, data.locationId), isOurs));
		if (!ours) throw new LedgerError("Kits are built on our own shelves");
		const input = {
			kitProductId: data.productId,
			quantity: data.quantity,
			locationId: data.locationId,
		};
		const { batchId } =
			data.direction === "assemble"
				? await assembleKits(db, input)
				: await disassembleKits(db, input);
		return { batchId };
	});

// Refused, saying why, when it has any history (src/products/archive.ts).
export const deleteProductNow = createServerFn({ method: "POST" })
	.validator(type({ sku: "string > 0" }))
	.handler(async ({ data }) => deleteProduct(getDb(), data.sku));
