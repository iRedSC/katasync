import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	addUnit,
	deleteUnit,
	listUnits,
	renameUnit,
	setLineTerms,
	setPurchaseUnit,
} from "#/purchasing/units";

// What a supplier sells a product in (CASE of 30) and the fewest it sells.
export const setProductPurchaseUnit = createServerFn({ method: "POST" })
	.validator(
		type({
			productId: "number.integer > 0",
			supplierId: "number.integer > 0",
			unit: "string > 0",
			packSize: "number.integer > 0",
			supplierCount: "number.integer > 0",
			minimumQuantity: "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => setPurchaseUnit(getDb(), data));

// What one draft PO orders a product in, and its minimum. makeDefault also
// makes them the PO supplier's default for the product.
export const setPurchaseLineTerms = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			productId: "number.integer > 0",
			unit: "string > 0",
			packSize: "number.integer > 0",
			supplierCount: "number.integer > 0",
			minimumQuantity: "number.integer > 0",
			makeDefault: "boolean",
		}),
	)
	.handler(async ({ data }) => setLineTerms(getDb(), data));

export const listPurchaseUnits = createServerFn({ method: "GET" }).handler(
	async () => listUnits(getDb()),
);

export const addPurchaseUnit = createServerFn({ method: "POST" })
	.validator(type({ name: "string" }))
	.handler(async ({ data }) => addUnit(getDb(), data.name));

export const renamePurchaseUnit = createServerFn({ method: "POST" })
	.validator(type({ from: "string > 0", to: "string" }))
	.handler(async ({ data }) => renameUnit(getDb(), data.from, data.to));

export const deletePurchaseUnit = createServerFn({ method: "POST" })
	.validator(type({ name: "string > 0" }))
	.handler(async ({ data }) => deleteUnit(getDb(), data.name));
