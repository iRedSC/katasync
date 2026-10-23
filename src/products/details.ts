import { and, eq, ne } from "drizzle-orm";
import type { Db } from "#/db/client";
import { products } from "#/db/schema";
import { setCost } from "#/inventory/valuation";

// A product's own details: what it's called, how it scans, what one costs,
// and how it ships. Sizes come in inches and ounces, like the box tools, and
// are stored in millimeters and grams.

export class ProductError extends Error {
	name = "ProductError";
}

const MM_PER_INCH = 25.4;
const GRAMS_PER_OUNCE = 28.349523125;

export type ProductDetails = {
	name: string;
	variantName: string | null;
	category: string | null;
	barcode: string | null;
	// USD per one of the product: the average cost of its stock, which
	// receiving POs keeps up to date (src/inventory/valuation.ts). Setting it
	// by hand revalues what's on the shelf; sales already made keep theirs.
	unitCost: number | null;
	weightOz: number | null;
	lengthIn: number | null;
	widthIn: number | null;
	heightIn: number | null;
};

// When a cost was set. Only with a cost: undo puts a cost back as of when
// it was first set, rather than as set now.
type CostChange =
	| { unitCost?: number | null; unitCostSetAt?: never }
	| { unitCost: number; unitCostSetAt: Date };

// Changes only the given details. null clears one.
export async function updateProductDetails(
	db: Db,
	productId: number,
	details: Partial<Omit<ProductDetails, "unitCost">> & CostChange,
) {
	const text = (v: string | null | undefined) =>
		v === undefined ? undefined : v?.trim() || null;
	const measure = (
		v: number | null | undefined,
		label: string,
		factor: number,
	) => {
		if (v === undefined || v === null) return v;
		if (!(v > 0)) throw new ProductError(`The ${label} must be over 0`);
		return Math.round(v * factor);
	};
	if (details.name !== undefined && details.name.trim() === "")
		throw new ProductError("A product needs a name");
	if (details.unitCost != null && !(details.unitCost >= 0))
		throw new ProductError(`Cost can't be ${details.unitCost}`);

	const [product] = await db
		.select({ groupId: products.groupId })
		.from(products)
		.where(eq(products.id, productId));
	if (!product) throw new ProductError("No such product");
	const variantName = text(details.variantName);
	if (variantName && product.groupId === null)
		throw new ProductError(
			"Only a product in a group has a variant name; this one isn't in one",
		);
	const barcode = text(details.barcode);
	if (barcode) {
		const [taken] = await db
			.select({ sku: products.sku })
			.from(products)
			.where(and(eq(products.barcode, barcode), ne(products.id, productId)));
		if (taken)
			throw new ProductError(`Barcode ${barcode} is already on ${taken.sku}`);
	}

	const set = Object.fromEntries(
		Object.entries({
			name: details.name?.trim(),
			variantName,
			category: text(details.category),
			barcode,
			weightGrams: measure(details.weightOz, "weight", GRAMS_PER_OUNCE),
			lengthMm: measure(details.lengthIn, "length", MM_PER_INCH),
			widthMm: measure(details.widthIn, "width", MM_PER_INCH),
			heightMm: measure(details.heightIn, "height", MM_PER_INCH),
		}).filter(([, v]) => v !== undefined),
	);
	if (Object.keys(set).length > 0)
		await db.update(products).set(set).where(eq(products.id, productId));
	// Entering the same cost again confirms it, so it's dated now. A trigger
	// clears the date along with the cost, and takes a date ahead of now as now.
	if (details.unitCost !== undefined)
		await db.transaction((tx) =>
			setCost(tx, {
				productId,
				cost: details.unitCost ?? null,
				setAt: details.unitCostSetAt,
				note: details.unitCostSetAt ? "Undo" : undefined,
			}),
		);
	const [saved] = await db
		.select()
		.from(products)
		.where(eq(products.id, productId));
	return saved;
}
