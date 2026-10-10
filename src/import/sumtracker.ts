import { type } from "arktype";
import { parse } from "csv-parse/sync";
import { count, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	productAliases,
	productGroups,
	products,
} from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";

// One-time import of a Sumtracker export (products.csv, bundles.csv,
// stock-levels.csv). Build the plan first, review its warnings, then apply it
// to an empty database.

const productRow = type({
	sku: "string > 0",
	name: "string > 0",
	variant_name: "string",
	barcode: "string",
	product_type: "string",
	bundle_type: "'NONE' | 'BUNDLE'",
	is_archived: "'True' | 'False'",
	wavg_landed_cost: "string",
	image_url: "string",
	"+": "delete",
});

const bundleRow = type({
	sku: "string > 0",
	component_sku: "string > 0",
	quantity: type("string.integer.parse").to("number > 0"),
	"+": "delete",
});

const stockRow = type({
	sku: "string > 0",
	warehouse: "string",
	in_stock: "string.integer.parse",
	"+": "delete",
});

// Sumtracker tracks some Amazon listings (mostly FBA) as separate products
// named "<base SKU>-AMZ": either zero-stock products, or bundles of exactly one
// base unit. Here they become aliases of the base product instead.
const AMAZON_SUFFIX = "-AMZ";

export type ImportPlan = {
	groups: { name: string; imageUrl: string | null }[];
	products: {
		sku: string;
		name: string;
		kind: "simple" | "bundle";
		groupName: string | null;
		variantName: string | null;
		imageUrl: string | null;
		category: string | null;
		barcode: string | null;
		unitCost: number | null;
	}[];
	recipes: Map<string, { sku: string; quantity: number }[]>;
	aliases: { alias: string; sku: string }[];
	openingStock: { sku: string; quantity: number }[];
	warnings: string[];
};

export function planSumtrackerImport(files: {
	products: string;
	bundles: string;
	stock: string;
}): ImportPlan {
	const productRows = readCsv(files.products, productRow, "products.csv");
	const bundleRows = readCsv(files.bundles, bundleRow, "bundles.csv");
	const stockRows = readCsv(files.stock, stockRow, "stock-levels.csv");
	const errors: string[] = [];
	const warnings: string[] = [];

	const archived = productRows.filter((r) => r.is_archived === "True");
	if (archived.length > 0)
		warnings.push(`Skipped ${archived.length} archived products`);
	const active = productRows.filter((r) => r.is_archived === "False");

	const bySku = new Map(active.map((r) => [r.sku, r]));
	if (bySku.size !== active.length)
		errors.push("products.csv has duplicate SKUs");

	const aliases: ImportPlan["aliases"] = [];
	for (const row of active) {
		const base = row.sku.endsWith(AMAZON_SUFFIX)
			? bySku.get(row.sku.slice(0, -AMAZON_SUFFIX.length))
			: undefined;
		if (!base) continue;
		aliases.push({ alias: row.sku, sku: base.sku });
		if (base.bundle_type === "BUNDLE") {
			warnings.push(
				`Amazon alias ${row.sku} points at bundle ${base.sku}; FBA listings can't map to bundles`,
			);
		}
	}
	const aliasSkus = new Set(aliases.map((a) => a.alias));
	const imported = active.filter((r) => !aliasSkus.has(r.sku));

	const barcodeOwners = new Map<string, string[]>();
	for (const row of imported) {
		const barcode = cleanBarcode(row.barcode);
		if (barcode)
			barcodeOwners.set(barcode, [
				...(barcodeOwners.get(barcode) ?? []),
				row.sku,
			]);
	}
	for (const [barcode, owners] of barcodeOwners) {
		if (owners.length > 1)
			warnings.push(
				`Barcode ${barcode} is shared by ${owners.join(", ")}; left blank on all`,
			);
	}

	const groups = new Map<string, string | null>();
	const planned: ImportPlan["products"] = imported.map((row) => {
		const variantName = row.variant_name.trim() || null;
		if (variantName && !groups.has(row.name))
			groups.set(row.name, row.image_url || null);
		const barcode = cleanBarcode(row.barcode);
		const cost = Number(row.wavg_landed_cost);
		return {
			sku: row.sku,
			name: row.name,
			kind: row.bundle_type === "BUNDLE" ? "bundle" : "simple",
			groupName: variantName ? row.name : null,
			variantName,
			imageUrl: row.image_url || null,
			category: row.product_type.trim() || null,
			barcode:
				barcode && barcodeOwners.get(barcode)?.length === 1 ? barcode : null,
			// A zero cost in Sumtracker means nobody entered one.
			unitCost: cost > 0 ? cost : null,
		};
	});
	const kindOf = new Map(planned.map((p) => [p.sku, p.kind]));

	const recipes: ImportPlan["recipes"] = new Map();
	const aliasBase = new Map(aliases.map((a) => [a.alias, a.sku]));
	for (const row of bundleRows) {
		if (aliasBase.has(row.sku)) {
			if (row.component_sku !== aliasBase.get(row.sku) || row.quantity !== 1) {
				errors.push(
					`bundles.csv: Amazon alias ${row.sku} contains more than 1 × ${aliasBase.get(row.sku)}`,
				);
			}
		} else if (kindOf.get(row.sku) !== "bundle") {
			errors.push(`bundles.csv: ${row.sku} is not an imported bundle`);
		} else if (kindOf.get(row.component_sku) !== "simple") {
			errors.push(
				`bundles.csv: component ${row.component_sku} of ${row.sku} is not an imported simple product`,
			);
		} else {
			recipes.set(row.sku, [
				...(recipes.get(row.sku) ?? []),
				{ sku: row.component_sku, quantity: row.quantity },
			]);
		}
	}
	for (const p of planned) {
		if (p.kind === "bundle" && !recipes.has(p.sku)) {
			warnings.push(
				`Bundle ${p.sku} has no components; it will show 0 available`,
			);
		}
	}

	const openingStock: ImportPlan["openingStock"] = [];
	for (const row of stockRows) {
		if (row.warehouse !== "WAREHOUSE") {
			errors.push(
				`stock-levels.csv: unexpected warehouse "${row.warehouse}" for ${row.sku}`,
			);
		} else if (aliasSkus.has(row.sku)) {
			if (row.in_stock !== 0)
				warnings.push(
					`Dropped stock of ${row.in_stock} on Amazon alias ${row.sku}`,
				);
		} else if (kindOf.get(row.sku) !== "simple") {
			errors.push(
				`stock-levels.csv: ${row.sku} is not an imported simple product`,
			);
		} else if (row.in_stock !== 0) {
			openingStock.push({ sku: row.sku, quantity: row.in_stock });
		}
	}

	if (errors.length > 0)
		throw new Error(`Sumtracker export is invalid:\n${errors.join("\n")}`);
	return {
		groups: [...groups].map(([name, imageUrl]) => ({ name, imageUrl })),
		products: planned,
		recipes,
		aliases,
		openingStock,
		warnings,
	};
}

// Writes the plan in one transaction. Refuses to run if any products exist, so
// opening balances can't be imported twice.
export async function applySumtrackerImport(
	db: Db,
	plan: ImportPlan,
	locationName: string,
) {
	return db.transaction(async (tx) => {
		const [{ existing }] = await tx
			.select({ existing: count() })
			.from(products);
		if (existing > 0)
			throw new Error(
				`Database already has ${existing} products; import needs an empty catalog`,
			);

		let [location] = await tx
			.select()
			.from(locations)
			.where(eq(locations.name, locationName));
		location ??= (
			await tx
				.insert(locations)
				.values({ name: locationName, kind: "owned" })
				.returning()
		)[0];

		const groupIds = new Map<string, number>();
		for (const chunk of chunks(plan.groups, 500)) {
			const rows = await tx.insert(productGroups).values(chunk).returning();
			for (const g of rows) groupIds.set(g.name, g.id);
		}

		const productIds = new Map<string, number>();
		for (const chunk of chunks(plan.products, 500)) {
			const rows = await tx
				.insert(products)
				.values(
					chunk.map(({ groupName, ...p }) => ({
						...p,
						groupId: groupName === null ? null : groupIds.get(groupName),
					})),
				)
				.returning({ id: products.id, sku: products.sku });
			for (const p of rows) productIds.set(p.sku, p.id);
		}
		const idOf = (sku: string) => {
			const id = productIds.get(sku);
			if (id === undefined) throw new Error(`Product ${sku} was not imported`);
			return id;
		};

		for (const [bundleSku, components] of plan.recipes) {
			await setRecipe(
				tx,
				idOf(bundleSku),
				components.map((c) => ({
					productId: idOf(c.sku),
					quantity: c.quantity,
				})),
			);
		}

		if (plan.aliases.length > 0) {
			await tx
				.insert(productAliases)
				.values(
					plan.aliases.map((a) => ({ alias: a.alias, productId: idOf(a.sku) })),
				);
		}

		if (plan.openingStock.length > 0) {
			await postMovements(tx, {
				reference: "sumtracker-import",
				lines: plan.openingStock.map((s) => ({
					productId: idOf(s.sku),
					locationId: location.id,
					delta: s.quantity,
					reason: "opening_balance" as const,
				})),
			});
		}

		return {
			products: productIds.size,
			groups: groupIds.size,
			bundles: plan.recipes.size,
			aliases: plan.aliases.length,
			stockLines: plan.openingStock.length,
		};
	});
}

function readCsv<T>(
	text: string,
	schema: (data: unknown) => T | type.errors,
	file: string,
): T[] {
	const rows: unknown[] = parse(text, {
		columns: true,
		skip_empty_lines: true,
		bom: true,
	});
	return rows.map((row, i) => {
		const result = schema(row);
		// Header is line 1, so data row i is on line i + 2.
		if (result instanceof type.errors)
			throw new Error(`${file} line ${i + 2}: ${result.summary}`);
		return result;
	});
}

// Spreadsheet exports prefix numeric barcodes with ' to keep leading zeros.
function cleanBarcode(raw: string) {
	return raw.trim().replace(/^'/, "") || null;
}

function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
}
