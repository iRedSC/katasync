import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	countLog,
	listings,
	locations,
	movements,
	orderLines,
	productAliases,
	productComponents,
	productSuppliers,
	products,
	purchaseOrderAmendments,
	purchaseOrderLines,
	purchaseOrderSentSets,
	purchaseOrderSkippedParts,
	purchaseOrders,
	stockCounts,
	stockLevels,
} from "#/db/schema";
import { ProductError } from "./details";

// Retiring products. One with history is archived: it leaves lists, pickers,
// reordering, counting, and listing matching, and its sales, POs, and ledger
// stay. One with none (made by mistake) can be deleted outright.
//
// Only an inert product is archived, so hiding it can't hide anything still
// happening: no live listing sells it, none is on our shelves, no active kit
// or tool set holds it, and no open PO has it. Each refusal says what to
// settle first. The product row stays locked while archiving; writes that
// would make it active again (a PO line, a part, a listing match) read it
// with a share lock, so one can't slip in between the check and the archive.

// Products still carried. Use wherever a product is offered or planned for;
// history and order resolution keep archived ones.
export const carried = isNull(products.archivedAt);

// Carried, or archived with stock on our shelves again (a return came back,
// a kit was taken apart): lists and counting still show those, so stock is
// never out of sight. Reordering doesn't.
export const carriedOrStocked = sql`(${carried} or exists (select 1 from ${stockLevels} join ${locations} on ${locations.id} = ${stockLevels.locationId} where ${stockLevels.productId} = ${products.id} and ${locations.kind} = 'owned' and ${stockLevels.onHand} <> 0))`;

// A listing its channel can't sell: deleted (TikTok), archived (Shopify), or
// inactive (Amazon). eBay only reports live listings, so those always sell.
export const listingEnded = sql`upper(coalesce(${listings.status}, '')) in ('DELETED', 'ARCHIVED', 'INACTIVE')`;

async function productNamed(tx: Db, sku: string) {
	const [product] = await tx
		.select()
		.from(products)
		.where(eq(products.sku, sku.trim()))
		.for("update");
	if (!product) throw new ProductError(`No product with SKU ${sku}`);
	return product;
}

const titles = (rows: { title: string }[]) =>
	rows
		.slice(0, 5)
		.map((r) => r.title)
		.join(", ") + (rows.length > 5 ? `, and ${rows.length - 5} more` : "");

// What keeps a product from being archived, in words; empty when nothing.
async function stillActive(tx: Db, id: number) {
	const blockers: string[] = [];
	const live = await tx
		.select({ title: listings.title })
		.from(listings)
		.where(and(eq(listings.productId, id), sql`not ${listingEnded}`));
	if (live.length > 0)
		blockers.push(
			`live listings sell it (${titles(live)}); end them on the channel or relink them`,
		);
	const shelves = await tx
		.select({ name: locations.name, onHand: stockLevels.onHand })
		.from(stockLevels)
		.innerJoin(locations, eq(locations.id, stockLevels.locationId))
		.where(
			and(
				eq(stockLevels.productId, id),
				eq(locations.kind, "owned"),
				ne(stockLevels.onHand, 0),
			),
		);
	if (shelves.length > 0)
		blockers.push(
			`${shelves.map((s) => `${s.onHand} on hand at ${s.name}`).join(", ")}; sell, adjust, or count it to 0 first`,
		);
	const parents = await tx
		.select({ title: products.sku })
		.from(productComponents)
		.innerJoin(products, eq(products.id, productComponents.parentProductId))
		.where(and(eq(productComponents.componentProductId, id), carried));
	if (parents.length > 0)
		blockers.push(
			`it's a part of ${titles(parents)}; change their parts or archive them first`,
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
	for (const s of sentSets)
		if (!open.some((o) => o.number === s.number)) open.push(s);
	if (open.length > 0)
		blockers.push(
			`it's on open PO ${open.map((p) => p.number).join(", ")}; take it off, or receive or close the PO`,
		);
	return blockers;
}

export async function archiveProduct(db: Db, sku: string) {
	return db.transaction(async (tx) => {
		const product = await productNamed(tx, sku);
		if (product.archivedAt)
			return { sku: product.sku, archivedAt: product.archivedAt };
		const blockers = await stillActive(tx, product.id);
		if (blockers.length > 0)
			throw new ProductError(
				`Can't archive ${product.sku}: ${blockers.join("; ")}`,
			);
		const [saved] = await tx
			.update(products)
			.set({ archivedAt: new Date() })
			.where(eq(products.id, product.id))
			.returning({ sku: products.sku, archivedAt: products.archivedAt });
		return saved;
	});
}

// Carried again: back in lists, reordering, counting, and matching. A kit or
// tool set comes back only once its parts are carried.
export async function restoreProduct(db: Db, sku: string) {
	return db.transaction(async (tx) => {
		const product = await productNamed(tx, sku);
		const archivedParts = await tx
			.select({ sku: products.sku })
			.from(productComponents)
			.innerJoin(
				products,
				eq(products.id, productComponents.componentProductId),
			)
			.where(
				and(
					eq(productComponents.parentProductId, product.id),
					isNotNull(products.archivedAt),
				),
			)
			.for("share", { of: products });
		if (archivedParts.length > 0)
			throw new ProductError(
				`Can't restore ${product.sku}: its parts ${archivedParts.map((p) => p.sku).join(", ")} are archived; restore them first`,
			);
		await tx
			.update(products)
			.set({ archivedAt: null })
			.where(eq(products.id, product.id));
		return { sku: product.sku, archivedAt: null };
	});
}

// Tables that are a product's history. Any row in one means archive, not
// delete. Listings come first: they must be relinked or unlinked by hand,
// since the next sync could match them straight back or make the product
// again.
const history = [
	["listings sell it", listings, listings.productId],
	["it sold on orders", orderLines, orderLines.productId],
	["stock moved", movements, movements.productId],
	["it was counted", countLog, countLog.productId],
	["it was counted", stockCounts, stockCounts.productId],
	["it's on POs", purchaseOrderLines, purchaseOrderLines.productId],
	["it's on POs", purchaseOrderAmendments, purchaseOrderAmendments.productId],
	["it's on POs", purchaseOrderSentSets, purchaseOrderSentSets.setProductId],
	[
		"it's on POs",
		purchaseOrderSkippedParts,
		purchaseOrderSkippedParts.setProductId,
	],
	[
		"it's on POs",
		purchaseOrderSkippedParts,
		purchaseOrderSkippedParts.partProductId,
	],
	[
		"it's a part of kits or tool sets",
		productComponents,
		productComponents.componentProductId,
	],
] as const;

// Deletes a product that never did anything, with what's only its own: its
// parts list, aliases, supplier terms, and empty shelves. Refused, saying
// why, when it has history; archive it instead.
export async function deleteProduct(db: Db, sku: string) {
	return db.transaction(async (tx) => {
		const product = await productNamed(tx, sku);
		const held = new Set<string>();
		for (const [why, table, column] of history) {
			const [row] = await tx
				.select({ one: sql`1` })
				.from(table)
				.where(eq(column, product.id))
				.limit(1);
			if (row) held.add(why);
		}
		if (held.size > 0)
			throw new ProductError(
				`Can't delete ${product.sku}: ${[...held].join(", ")}. Archive it instead${held.has("listings sell it") ? ", or relink or unlink its listings first" : ""}`,
			);
		await tx
			.delete(productComponents)
			.where(eq(productComponents.parentProductId, product.id));
		await tx
			.delete(productAliases)
			.where(eq(productAliases.productId, product.id));
		await tx
			.delete(productSuppliers)
			.where(eq(productSuppliers.productId, product.id));
		await tx.delete(stockLevels).where(eq(stockLevels.productId, product.id));
		await tx.delete(products).where(eq(products.id, product.id));
		return { sku: product.sku, deleted: true };
	});
}
