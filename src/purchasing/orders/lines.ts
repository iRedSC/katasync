import { and, eq, isNull, notExists } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	productComponents,
	productSuppliers,
	products,
	purchaseOrderAmendments,
	purchaseOrderDiscounts,
	purchaseOrderLines,
	purchaseOrderSkippedParts,
	type purchaseOrders,
} from "#/db/schema";
import type { Discount } from "#/purchasing/discount";
import { discountRow } from "#/purchasing/discount";
import { reopen } from "./closing";
import { checkDiscounts, checkOff } from "./discount-checks";
import { lockForEdit, PurchaseOrderError, poName } from "./lock";
import { checkPrice } from "./price";
import type { AddedLine, Status } from "./types";

// Sets how many of a product a draft orders, adding the line if needed. 0
// removes it. A new line is in the supplier's unit (EACH when the product has
// no supplier). Leaving out unitCost keeps the line's price, or starts a new
// line at the supplier's price. With inItems, quantity counts single items and
// rounds up to whole packs of the line's pack size, read under the same lock
// as the write so a change to the terms can't slip in between. Returns the
// line's terms and the quantity it ended up with, in its unit. A tool set gets
// its own line here and is split into its parts when the PO is sent.
// `discounts`, when given, replace the line's, e.g. putting back a line that
// was taken off; `addedAt` puts it back where it sat (see addedAtOf).
export async function setDraftLine(
	db: Db,
	input: {
		purchaseOrderId: number;
		productId: number;
		quantity: number;
		inItems?: boolean;
		unitCost?: number | null;
		discounts?: Discount[];
		addedAt?: Date;
	},
) {
	if (!Number.isInteger(input.quantity) || input.quantity < 0)
		throw new PurchaseOrderError(
			`Quantity must be a whole number, got ${input.quantity}`,
		);
	checkPrice(input.unitCost);
	return db.transaction(async (tx) => {
		const po = await lockForEdit(tx, input.purchaseOrderId);
		const where = and(
			eq(purchaseOrderLines.purchaseOrderId, po.id),
			eq(purchaseOrderLines.productId, input.productId),
		);
		const product = await newLine(tx, input.productId);
		// A line already on the draft keeps its own terms; a new one starts
		// with the supplier's.
		const [existing] = await tx
			.select({
				unit: purchaseOrderLines.unit,
				packSize: purchaseOrderLines.packSize,
				supplierCount: purchaseOrderLines.supplierCount,
				minimumQuantity: purchaseOrderLines.minimumQuantity,
			})
			.from(purchaseOrderLines)
			.where(where);
		const terms = existing ?? product.terms;
		const quantity = input.inItems
			? Math.ceil(input.quantity / terms.packSize)
			: input.quantity;
		if (quantity === 0) {
			await tx.delete(purchaseOrderLines).where(where);
			return { ...terms, quantity };
		}
		await refuseEmptySet(tx, input.productId, product);
		if (product.kind === "bundle" && input.unitCost != null)
			throw new PurchaseOrderError(
				`${product.sku} is a tool set; it's priced as its parts when sent`,
			);
		const [line] = await tx
			.insert(purchaseOrderLines)
			.values({
				purchaseOrderId: po.id,
				productId: input.productId,
				...terms,
				quantity,
				// A new line's terms are the supplier's, so its price is too.
				unitCost:
					input.unitCost !== undefined ? input.unitCost : product.unitCost,
				addedAt: addedAtOf(input.addedAt),
			})
			.onConflictDoUpdate({
				target: [
					purchaseOrderLines.purchaseOrderId,
					purchaseOrderLines.productId,
				],
				set: {
					quantity,
					...(input.unitCost !== undefined ? { unitCost: input.unitCost } : {}),
				},
			})
			.returning({ id: purchaseOrderLines.id });
		if (input.discounts) {
			for (const d of input.discounts) checkOff(d.off);
			await tx
				.delete(purchaseOrderDiscounts)
				.where(eq(purchaseOrderDiscounts.lineId, line.id));
			if (input.discounts.length > 0)
				await tx.insert(purchaseOrderDiscounts).values(
					input.discounts.map((d) => ({
						lineId: line.id,
						...discountRow(d),
					})),
				);
		}
		await checkDiscounts(tx, line.id);
		return { ...terms, quantity };
	});
}

// Locks a draft line's quantity so Update leaves it alone, or unlocks it.
// Like any change, it makes a suggested PO a draft.
export async function lockDraftLine(
	db: Db,
	input: { purchaseOrderId: number; productId: number; locked: boolean },
) {
	await db.transaction(async (tx) => {
		const po = await lockForEdit(tx, input.purchaseOrderId);
		const changed = await tx
			.update(purchaseOrderLines)
			.set({ locked: input.locked })
			.where(
				and(
					eq(purchaseOrderLines.purchaseOrderId, po.id),
					eq(purchaseOrderLines.productId, input.productId),
				),
			)
			.returning({ id: purchaseOrderLines.id });
		if (changed.length === 0)
			throw new PurchaseOrderError(`That product isn't on ${poName(po.id)}`);
	});
}

// What a new line for the product starts with: the supplier's terms (EACH
// when it has no supplier) and price.
export async function newLine(tx: Db, productId: number) {
	const [product] = await tx
		.select({
			kind: products.kind,
			sku: products.sku,
			productCost: products.unitCost,
			supplierCost: productSuppliers.cost,
			unit: productSuppliers.unit,
			packSize: productSuppliers.packSize,
			supplierCount: productSuppliers.supplierCount,
			minimumQuantity: productSuppliers.minimumQuantity,
			archivedAt: products.archivedAt,
		})
		.from(products)
		.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
		.where(eq(products.id, productId))
		// Held until the line is in, so archiving waits (src/products/archive.ts).
		.for("share", { of: products });
	if (!product) throw new PurchaseOrderError("That product doesn't exist");
	if (product.archivedAt)
		throw new PurchaseOrderError(
			`${product.sku} is archived; restore it to order it`,
		);
	const packSize = product.packSize ?? 1;
	return {
		kind: product.kind,
		sku: product.sku,
		terms: {
			unit: product.unit ?? "EACH",
			packSize,
			supplierCount: product.supplierCount ?? 1,
			minimumQuantity: product.minimumQuantity ?? 1,
		},
		// A tool set has no price of its own: sending replaces it with its
		// parts, each at its own price.
		unitCost:
			product.kind === "bundle"
				? null
				: (product.supplierCost ??
					(product.productCost === null
						? null
						: product.productCost * packSize)),
	};
}

// A tool set goes on a draft as its own line and becomes its parts when the PO
// is sent, so it needs parts to become.
async function refuseEmptySet(
	tx: Db,
	productId: number,
	product: { kind: string; sku: string },
) {
	if (product.kind !== "bundle") return;
	const [part] = await tx
		.select({ id: productComponents.componentProductId })
		.from(productComponents)
		.where(eq(productComponents.parentProductId, productId))
		.limit(1);
	if (!part)
		throw new PurchaseOrderError(
			`${product.sku} has no parts; add them on its page`,
		);
}

// Everything about a line someone can change. Undoing an add compares all of
// it, so an edit made since is never thrown away.
const lineFields = {
	id: purchaseOrderLines.id,
	unit: purchaseOrderLines.unit,
	packSize: purchaseOrderLines.packSize,
	supplierCount: purchaseOrderLines.supplierCount,
	minimumQuantity: purchaseOrderLines.minimumQuantity,
	quantity: purchaseOrderLines.quantity,
	unitCost: purchaseOrderLines.unitCost,
};

// Puts a product on a draft at the supplier's terms and price, unless it's
// already there. A line already on the draft is never changed: it comes back
// with added false, so the caller can say where it is. Two adds at once
// queue on the PO's lock, so only one of them adds.
export async function addDraftLine(
	db: Db,
	input: { purchaseOrderId: number; productId: number; quantity: number },
): Promise<{ added: boolean; line: AddedLine }> {
	return addLine(db, input, ["draft"]);
}

// addDraftLine for any PO still open, including one already sent: the
// supplier sent something else, or something extra we're keeping. A line
// added after sending is never printed on the PO, since the supplier wasn't
// sent it. It reopens a closed PO, since now something is on its way.
export async function addLine(
	db: Db,
	input: {
		purchaseOrderId: number;
		productId: number;
		quantity: number;
		addedAt?: Date;
	},
	allowed: Status[] = ["draft", "sent", "closed"],
): Promise<{ added: boolean; line: AddedLine }> {
	if (!Number.isInteger(input.quantity) || input.quantity <= 0)
		throw new PurchaseOrderError(
			`Quantity must be a whole number above 0, got ${input.quantity}`,
		);
	return db.transaction(async (tx) => {
		const po = await lockForEdit(tx, input.purchaseOrderId, allowed);
		const result = await insertLine(tx, po, input);
		if (result.added && po.status !== "draft")
			await tx.insert(purchaseOrderAmendments).values({
				purchaseOrderId: po.id,
				productId: input.productId,
				kind: "added",
				quantityAfter: input.quantity,
			});
		return result;
	});
}

// Adds the line under the PO's lock, unless the product's already on it.
export async function insertLine(
	tx: Db,
	po: typeof purchaseOrders.$inferSelect,
	input: { productId: number; quantity: number; addedAt?: Date },
): Promise<{ added: boolean; line: AddedLine }> {
	const [existing] = await tx
		.select(lineFields)
		.from(purchaseOrderLines)
		.where(
			and(
				eq(purchaseOrderLines.purchaseOrderId, po.id),
				eq(purchaseOrderLines.productId, input.productId),
			),
		);
	if (existing) return { added: false, line: existing };
	const product = await newLine(tx, input.productId);
	if (product.kind === "bundle" && po.status !== "draft")
		throw new PurchaseOrderError(
			`${product.sku} is a tool set; add the parts that came instead`,
		);
	await refuseEmptySet(tx, input.productId, product);
	const [line] = await tx
		.insert(purchaseOrderLines)
		.values({
			purchaseOrderId: po.id,
			productId: input.productId,
			...product.terms,
			quantity: input.quantity,
			unitCost: product.unitCost,
			addedAt: addedAtOf(input.addedAt),
		})
		.returning(lineFields);
	if (po.status === "closed" && input.quantity > 0) await reopen(tx, po.id);
	return { added: true, line };
}

// Undoes addDraftLine: takes the line off only if it's still exactly as
// added. Returns false, leaving it alone, when someone has changed it since.
// The draft stays even if the add started it; an empty draft is harmless.
export async function removeAddedLine(
	db: Db,
	input: { purchaseOrderId: number; line: AddedLine },
): Promise<boolean> {
	const { line } = input;
	return db.transaction(async (tx) => {
		await lockForEdit(tx, input.purchaseOrderId);
		const removed = await tx
			.delete(purchaseOrderLines)
			.where(
				and(
					eq(purchaseOrderLines.id, line.id),
					eq(purchaseOrderLines.purchaseOrderId, input.purchaseOrderId),
					eq(purchaseOrderLines.unit, line.unit),
					eq(purchaseOrderLines.packSize, line.packSize),
					eq(purchaseOrderLines.supplierCount, line.supplierCount),
					eq(purchaseOrderLines.minimumQuantity, line.minimumQuantity),
					eq(purchaseOrderLines.quantity, line.quantity),
					line.unitCost === null
						? isNull(purchaseOrderLines.unitCost)
						: eq(purchaseOrderLines.unitCost, line.unitCost),
					// So is a discount.
					notExists(
						tx
							.select({ id: purchaseOrderDiscounts.id })
							.from(purchaseOrderDiscounts)
							.where(eq(purchaseOrderDiscounts.lineId, purchaseOrderLines.id)),
					),
					// Skipping one of a set's parts is a change too.
					notExists(
						tx
							.select({ id: purchaseOrderSkippedParts.partProductId })
							.from(purchaseOrderSkippedParts)
							.where(
								and(
									eq(
										purchaseOrderSkippedParts.purchaseOrderId,
										input.purchaseOrderId,
									),
									eq(
										purchaseOrderSkippedParts.setProductId,
										purchaseOrderLines.productId,
									),
								),
							),
					),
				),
			)
			.returning({ id: purchaseOrderLines.id });
		return removed.length > 0;
	});
}

// When a new line counts as added: now, or for a line being put back, when
// it was first added. A time still to come is ignored; it would only hide the
// line below ones added after it.
function addedAtOf(was: Date | undefined) {
	return was !== undefined && was <= new Date() ? was : undefined;
}
