import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrders,
	purchaseUnits,
} from "#/db/schema";
import {
	convertDiscounts,
	lockForEdit,
	PurchaseOrderError,
} from "#/purchasing/orders";
import { perPack } from "#/purchasing/pack";

// The units suppliers sell in, and which one each product is bought in.
// Stock always counts the product itself; a unit only changes how POs are
// ordered, priced, and received.

// One of the product itself. Always there, never renamed or removed.
export const EACH = "EACH";

// Units read like the labels on a box: "CASE", "BAG OF 50".
export function unitName(raw: string) {
	const name = raw.trim().replace(/\s+/g, " ").toUpperCase();
	if (name === "") throw new PurchaseOrderError("Give the unit a name");
	if (name.length > 20)
		throw new PurchaseOrderError(`"${name}" is too long; keep it under 20`);
	return name;
}

// Every unit with how many products are bought in it. EACH first.
export async function listUnits(db: Db) {
	const rows = await db
		.select({
			name: purchaseUnits.name,
			products: sql<number>`(select count(*) from product_suppliers ps where ps.unit = "purchase_units"."name")::int`,
		})
		.from(purchaseUnits)
		.orderBy(asc(purchaseUnits.name));
	return [
		...rows.filter((u) => u.name === EACH),
		...rows.filter((u) => u.name !== EACH),
	];
}

export async function addUnit(db: Db, raw: string) {
	const name = unitName(raw);
	const [added] = await db
		.insert(purchaseUnits)
		.values({ name })
		.onConflictDoNothing()
		.returning();
	if (!added) throw new PurchaseOrderError(`${name} is already a unit`);
	return name;
}

// Products bought in the unit follow it, and so do draft lines. Sent POs keep
// the name they went out with.
export async function renameUnit(db: Db, from: string, raw: string) {
	if (from === EACH) throw new PurchaseOrderError("EACH can't be renamed");
	const to = unitName(raw);
	if (to === from) return to;
	return db.transaction(async (tx) => {
		const [taken] = await tx
			.select({ name: purchaseUnits.name })
			.from(purchaseUnits)
			.where(eq(purchaseUnits.name, to));
		if (taken) throw new PurchaseOrderError(`${to} is already a unit`);
		const [renamed] = await tx
			.update(purchaseUnits)
			.set({ name: to })
			.where(eq(purchaseUnits.name, from))
			.returning();
		if (!renamed) throw new PurchaseOrderError(`${from} isn't a unit`);
		await tx
			.update(purchaseOrderLines)
			.set({ unit: to })
			.where(
				and(
					eq(purchaseOrderLines.unit, from),
					inArray(purchaseOrderLines.purchaseOrderId, drafts(tx)),
				),
			);
		return to;
	});
}

// Only a unit nothing is bought in can go, so no product silently changes unit.
export async function deleteUnit(db: Db, name: string) {
	if (name === EACH) throw new PurchaseOrderError("EACH can't be removed");
	return db.transaction(async (tx) => {
		const users = await tx
			.select({ sku: products.sku })
			.from(productSuppliers)
			.innerJoin(products, eq(products.id, productSuppliers.productId))
			.where(eq(productSuppliers.unit, name))
			.orderBy(products.sku);
		if (users.length > 0)
			throw new PurchaseOrderError(
				`${users.length} ${users.length === 1 ? "product is" : "products are"} bought in ${name} (${users
					.slice(0, 3)
					.map((u) => u.sku)
					.join(", ")}${users.length > 3 ? ", …" : ""}). Change them first.`,
			);
		await tx.delete(purchaseUnits).where(eq(purchaseUnits.name, name));
	});
}

export { perPack };

// packSize is how many of the product one unit holds, and does the math.
// supplierCount is what the supplier calls it, printed on the PO: their
// "PACK of 5" may be one of ours, so packSize 1 and supplierCount 5.
export type UnitTerms = {
	unit: string;
	packSize: number;
	supplierCount: number;
	minimumQuantity: number;
};

async function checkTerms(db: Db, t: UnitTerms) {
	if (!Number.isInteger(t.packSize) || t.packSize < 1)
		throw new PurchaseOrderError(
			`Pack size must be a whole number, got ${t.packSize}`,
		);
	if (!Number.isInteger(t.supplierCount) || t.supplierCount < 1)
		throw new PurchaseOrderError(
			`The supplier's count must be a whole number, got ${t.supplierCount}`,
		);
	if (t.unit === EACH && (t.packSize !== 1 || t.supplierCount !== 1))
		throw new PurchaseOrderError(
			"EACH is one of the product; pick a unit like CASE for packs",
		);
	if (!Number.isInteger(t.minimumQuantity) || t.minimumQuantity < 1)
		throw new PurchaseOrderError(
			`Minimum must be a whole number, got ${t.minimumQuantity}`,
		);
	const [known] = await db
		.select({ name: purchaseUnits.name })
		.from(purchaseUnits)
		.where(eq(purchaseUnits.name, t.unit));
	if (!known) throw new PurchaseOrderError(`${t.unit} isn't a unit`);
}

// Puts a draft line in new terms. The quantity, price, and discounts convert
// so they still mean the same number of the product: 60 EACH becomes 2 CASE
// of 30.
// Quantities round up to whole units, then up to the new minimum, so 30 EACH
// in a CASE of 12 with a minimum of 4 becomes 4 CASE rather than 3.
async function convertLine(
	db: Db,
	line: {
		id: number;
		quantity: number;
		packSize: number;
		unitCost: number | null;
	},
	t: UnitTerms,
) {
	await db
		.update(purchaseOrderLines)
		.set({
			...t,
			quantity: Math.max(
				Math.ceil((line.quantity * line.packSize) / t.packSize),
				t.minimumQuantity,
			),
			unitCost:
				line.unitCost === null
					? null
					: perPack(line.unitCost, line.packSize, t.packSize),
		})
		.where(eq(purchaseOrderLines.id, line.id));
	await convertDiscounts(db, line, t.packSize);
}

// Sets the supplier's default terms for a product, converting its price to
// the new pack size.
async function setDefaultTerms(db: Db, productId: number, t: UnitTerms) {
	const [link] = await db
		.select()
		.from(productSuppliers)
		.where(eq(productSuppliers.productId, productId))
		.for("update");
	if (!link) throw new PurchaseOrderError("Set who it's bought from first");
	await db
		.update(productSuppliers)
		.set({
			...t,
			cost:
				link.cost === null
					? null
					: perPack(link.cost, link.packSize, t.packSize),
		})
		.where(eq(productSuppliers.productId, productId));
	return link;
}

// Changes what one draft PO orders a product in, and the minimum shown on
// it. With makeDefault, the product's supplier gets the same terms, so later
// POs start from them; only the product's own supplier's PO can do that.
export async function setLineTerms(
	db: Db,
	input: UnitTerms & {
		purchaseOrderId: number;
		productId: number;
		makeDefault: boolean;
	},
) {
	const { purchaseOrderId, productId, makeDefault, ...terms } = input;
	return db.transaction(async (tx) => {
		const po = await lockForEdit(tx, purchaseOrderId);
		await checkTerms(tx, terms);
		const [line] = await tx
			.select()
			.from(purchaseOrderLines)
			.where(
				and(
					eq(purchaseOrderLines.purchaseOrderId, po.id),
					eq(purchaseOrderLines.productId, productId),
				),
			);
		if (!line) throw new PurchaseOrderError("That product isn't on this PO");
		await convertLine(tx, line, terms);
		if (!makeDefault) return;
		const link = await setDefaultTerms(tx, productId, terms);
		if (link.supplierId !== po.supplierId)
			throw new PurchaseOrderError("Bought from another supplier");
	});
}

// Sets the supplier's default terms for a product, e.g. from its product
// page. Draft lines still on the old default follow it; a draft line given
// its own terms keeps them.
export async function setPurchaseUnit(
	db: Db,
	input: UnitTerms & { productId: number },
) {
	const { productId, ...terms } = input;
	return db.transaction(async (tx) => {
		await checkTerms(tx, terms);
		// Draft POs first, lowest id first, then the supplier row: the order
		// setLineTerms takes them in, so two saves can't each hold what the other
		// wants. The terms are read once the supplier row is ours.
		await tx
			.select({ id: purchaseOrders.id })
			.from(purchaseOrders)
			.where(
				and(
					eq(purchaseOrders.status, "draft"),
					inArray(
						purchaseOrders.id,
						tx
							.select({ id: purchaseOrderLines.purchaseOrderId })
							.from(purchaseOrderLines)
							.where(eq(purchaseOrderLines.productId, productId)),
					),
				),
			)
			.orderBy(asc(purchaseOrders.id))
			.for("update");
		const old = await setDefaultTerms(tx, productId, terms);
		const lines = await tx
			.select({
				id: purchaseOrderLines.id,
				quantity: purchaseOrderLines.quantity,
				packSize: purchaseOrderLines.packSize,
				unitCost: purchaseOrderLines.unitCost,
			})
			.from(purchaseOrderLines)
			.innerJoin(
				purchaseOrders,
				eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
			)
			.where(
				and(
					eq(purchaseOrderLines.productId, productId),
					eq(purchaseOrders.status, "draft"),
					eq(purchaseOrderLines.unit, old.unit),
					eq(purchaseOrderLines.packSize, old.packSize),
					eq(purchaseOrderLines.supplierCount, old.supplierCount),
					eq(purchaseOrderLines.minimumQuantity, old.minimumQuantity),
				),
			)
			.for("update");
		for (const line of lines) await convertLine(tx, line, terms);
	});
}

function drafts(db: Db) {
	return db
		.select({ id: purchaseOrders.id })
		.from(purchaseOrders)
		.where(eq(purchaseOrders.status, "draft"));
}
