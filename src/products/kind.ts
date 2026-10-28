import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "#/db/client";
import { committedStock } from "#/db/quantity-schema";
import {
	listings,
	locations,
	productComponents,
	products,
	purchaseOrderLines,
	purchaseOrderSentSets,
	purchaseOrders,
	stockLevels,
	transferLines,
	transfers,
} from "#/db/schema";
import { hasStockHistory, setRecipe } from "#/inventory/recipes";
import { ProductError } from "./details";

// Changing what kind of product a SKU is: a simple product found to be a
// pre-assembled kit, or a listing that's really a tool set sold as its parts.
// Kits and tool sets always come with their parts, so neither exists without
// them; going back to simple drops the parts.
//
// A tool set has no stock of its own, so a product only becomes one with
// nothing on any shelf, in transit, or reserved for orders, no FBA listing
// (Amazon stocks it, we can't build it), and no stock history: a past sale
// or receipt reversed later must find the shelf it came from. A kit with
// history stays a kit, since its history says what its units are made of. Nothing holds a tool set and
// kits hold no kits, so a part can't become either one its parents refuse.
// Any kind change waits for open POs and draft transfers holding it, which
// were made for the old kind. The product row stays locked throughout; stock
// and recipe writes lock it too, so none can slip in after the checks.

export type Part = { productId: number; quantity: number };

export type KindChange =
	| { kind: "simple" }
	| { kind: "kit" | "bundle"; components: Part[] };

const name = { simple: "simple product", kit: "kit", bundle: "tool set" };

export async function setProductKind(
	db: Db,
	productId: number,
	change: KindChange,
) {
	return db.transaction(async (tx) => {
		const [product] = await tx
			.select({ id: products.id, sku: products.sku, kind: products.kind })
			.from(products)
			.where(eq(products.id, productId))
			.for("update");
		if (!product) throw new ProductError(`Unknown product ${productId}`);

		if (product.kind !== change.kind) {
			const blockers = await blockersFor(
				tx,
				product.id,
				product.kind,
				change.kind,
			);
			if (blockers.length > 0)
				throw new ProductError(
					`Can't make ${product.sku} a ${name[change.kind]}: ${blockers.join("; ")}`,
				);
			await tx
				.update(products)
				.set({ kind: change.kind })
				.where(eq(products.id, product.id));
			// The old kind's parts go with it: a tool set becoming a kit is
			// given its first parts, not a change to a kit's.
			await tx
				.delete(productComponents)
				.where(eq(productComponents.parentProductId, product.id));
		}
		if (change.kind !== "simple")
			await setRecipe(tx, product.id, change.components);
		return { sku: product.sku, from: product.kind, kind: change.kind };
	});
}

// What keeps a product from becoming `kind`, in words; empty when nothing.
async function blockersFor(
	tx: Db,
	id: number,
	from: KindChange["kind"],
	kind: KindChange["kind"],
): Promise<string[]> {
	const blockers: string[] = [];
	if ((from === "kit" || kind === "bundle") && (await hasStockHistory(tx, id)))
		blockers.push(
			from === "kit"
				? "its stock history was built from its parts; make a new SKU instead"
				: "it has stock history, and a tool set has no stock of its own; make a new SKU for the tool set",
		);
	const parents = await tx
		.select({ sku: products.sku, kind: products.kind })
		.from(productComponents)
		.innerJoin(products, eq(products.id, productComponents.parentProductId))
		.where(eq(productComponents.componentProductId, id));
	const refusing = parents.filter(
		(p) => kind === "bundle" || (kind === "kit" && p.kind === "kit"),
	);
	if (refusing.length > 0)
		blockers.push(
			`it's a part of ${refusing.map((p) => p.sku).join(", ")}, which can't hold a ${name[kind]}; change their parts first`,
		);

	const open = await tx
		.selectDistinct({ number: purchaseOrders.id })
		.from(purchaseOrderLines)
		.innerJoin(
			purchaseOrders,
			eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
		)
		.where(
			and(
				eq(purchaseOrderLines.productId, id),
				inArray(purchaseOrders.status, ["suggested", "draft", "sent"]),
			),
		);
	const sentSets = await tx
		.selectDistinct({ number: purchaseOrders.id })
		.from(purchaseOrderSentSets)
		.innerJoin(
			purchaseOrders,
			eq(purchaseOrders.id, purchaseOrderSentSets.purchaseOrderId),
		)
		.where(
			and(
				eq(purchaseOrderSentSets.setProductId, id),
				eq(purchaseOrders.status, "sent"),
			),
		);
	const numbers = [...new Set([...open, ...sentSets].map((p) => p.number))];
	if (numbers.length > 0)
		blockers.push(
			`it's on open PO ${numbers.join(", ")}; take it off, or receive or close the PO`,
		);

	const drafts = await tx
		.selectDistinct({ id: transfers.id })
		.from(transferLines)
		.innerJoin(transfers, eq(transfers.id, transferLines.transferId))
		.where(and(eq(transferLines.productId, id), eq(transfers.status, "draft")));
	if (drafts.length > 0)
		blockers.push(
			`draft transfer ${drafts.map((t) => t.id).join(", ")} moves it; take it off or delete the transfer`,
		);

	if (kind !== "bundle") return blockers;

	const shelves = await tx
		.select({ name: locations.name, onHand: stockLevels.onHand })
		.from(stockLevels)
		.innerJoin(locations, eq(locations.id, stockLevels.locationId))
		.where(and(eq(stockLevels.productId, id), ne(stockLevels.onHand, 0)));
	if (shelves.length > 0)
		blockers.push(
			`${shelves.map((s) => `${s.onHand} on hand at ${s.name}`).join(", ")}; a tool set has no stock of its own, so sell, take apart, or count it to 0 first`,
		);
	const [reserved] = await tx
		.select({ units: committedStock.units })
		.from(committedStock)
		.where(and(eq(committedStock.productId, id), ne(committedStock.units, 0)));
	if (reserved)
		blockers.push(
			`${reserved.units} reserved for open orders; ship or cancel them first`,
		);
	const fba = await tx
		.select({ title: listings.title })
		.from(listings)
		.where(and(eq(listings.productId, id), eq(listings.fulfillment, "fba")));
	if (fba.length > 0)
		blockers.push(
			`FBA listings sell it (${fba.map((l) => l.title).join(", ")}); tool sets can't be FBA, so relink or unlink them`,
		);
	return blockers;
}
