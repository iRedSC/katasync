import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { getDb } from "#/db/client";
import { products } from "#/db/schema";
import { retailReserve } from "#/inventory/online-stock";
import {
	defaultMinStock,
	defaultRanges,
	setDefaultMinStock,
	setProductStockRange,
} from "#/inventory/stock-range";
import { restoreProduct } from "#/products/archive";
import { changeRetailReserve } from "#/stock-push/reserve";

// Quick ship asks about insurance for any order holding this product.
export const setInsureWhenShipped = createServerFn({ method: "POST" })
	.validator(type({ sku: "string > 0", insure: "boolean" }))
	.handler(async ({ data }) => {
		await getDb()
			.update(products)
			.set({ insureWhenShipped: data.insure })
			.where(eq(products.sku, data.sku));
	});

// Quick ship starts boxes holding this product as aerosol hazmat.
export const setAerosol = createServerFn({ method: "POST" })
	.validator(type({ sku: "string > 0", aerosol: "boolean" }))
	.handler(async ({ data }) => {
		await getDb()
			.update(products)
			.set({ aerosol: data.aerosol })
			.where(eq(products.sku, data.sku));
	});

// Critical products count toward their supplier's criticalThreshold when they
// need ordering (see purchasing/reorder.ts).
export const setCritical = createServerFn({ method: "POST" })
	.validator(type({ productId: "number.integer > 0", critical: "boolean" }))
	.handler(async ({ data }) => {
		await getDb()
			.update(products)
			.set({ critical: data.critical })
			.where(eq(products.id, data.productId));
	});

// The min products use until they get their own range.
export const getDefaultMinStock = createServerFn({ method: "GET" }).handler(
	async () => defaultMinStock(getDb()),
);

export const saveDefaultMinStock = createServerFn({ method: "POST" })
	.validator(type({ min: "number.integer >= 0" }))
	.handler(async ({ data }) => setDefaultMinStock(getDb(), data.min));

// Units Retail keeps for walk-ins; online orders only overflow into the rest.
export const getRetailReserve = createServerFn({ method: "GET" }).handler(
	async () => retailReserve(getDb()),
);

export const saveRetailReserve = createServerFn({ method: "POST" })
	.validator(type({ units: "number.integer >= 0" }))
	.handler(async ({ data }) => changeRetailReserve(getDb(), data.units));

// The range a product falls back on: min from settings, max from its sales.
export const getDefaultRange = createServerFn({ method: "GET" })
	.validator(type({ productId: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const range = (await defaultRanges(getDb(), [data.productId])).get(
			data.productId,
		);
		if (!range) throw new Error(`No product ${data.productId}`);
		return range;
	});

const range = type({ min: "number.integer >= 0", max: "number.integer > 0" });

// range null puts the product back on the defaults.
export const saveProductStockRange = createServerFn({ method: "POST" })
	.validator(type({ productId: "number.integer > 0", range: range.or("null") }))
	.handler(async ({ data }) =>
		setProductStockRange(getDb(), data.productId, data.range),
	);

// Carried again after being archived (over MCP).
export const restoreArchivedProduct = createServerFn({ method: "POST" })
	.validator(type({ sku: "string > 0" }))
	.handler(async ({ data }) => restoreProduct(getDb(), data.sku));
