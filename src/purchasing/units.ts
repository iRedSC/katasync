import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrders,
	purchaseUnits,
} from "#/db/schema";
import { PurchaseOrderError } from "#/purchasing/orders";

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

// Converts a price or count between pack sizes, e.g. $2 each is $60 a case of 30.
export const perPack = (perOld: number, oldPack: number, newPack: number) =>
	Math.round((perOld / oldPack) * newPack * 10_000) / 10_000;

// Sets what a product is bought in and the fewest the supplier sells. When
// the pack size changes, the supplier's price and any draft lines are
// converted so they still mean the same number of the product: a draft for
// 60 EACH becomes 2 CASE of 30. Draft quantities round up.
export async function setPurchaseUnit(
	db: Db,
	input: {
		productId: number;
		unit: string;
		packSize: number;
		minimumQuantity: number;
	},
) {
	const { productId, unit, packSize, minimumQuantity } = input;
	if (!Number.isInteger(packSize) || packSize < 1)
		throw new PurchaseOrderError(
			`Pack size must be a whole number, got ${packSize}`,
		);
	if (unit === EACH && packSize !== 1)
		throw new PurchaseOrderError(
			"EACH is one of the product; pick a unit like CASE for packs",
		);
	if (!Number.isInteger(minimumQuantity) || minimumQuantity < 1)
		throw new PurchaseOrderError(
			`Minimum must be a whole number, got ${minimumQuantity}`,
		);
	return db.transaction(async (tx) => {
		const [link] = await tx
			.select()
			.from(productSuppliers)
			.where(eq(productSuppliers.productId, productId))
			.for("update");
		if (!link) throw new PurchaseOrderError("Set who it's bought from first");
		const [known] = await tx
			.select({ name: purchaseUnits.name })
			.from(purchaseUnits)
			.where(eq(purchaseUnits.name, unit));
		if (!known) throw new PurchaseOrderError(`${unit} isn't a unit`);

		const oldPack = link.packSize;
		await tx
			.update(productSuppliers)
			.set({
				unit,
				packSize,
				minimumQuantity,
				cost: link.cost === null ? null : perPack(link.cost, oldPack, packSize),
			})
			.where(eq(productSuppliers.productId, productId));

		// Locked like every other draft change (see lockOrder in orders.ts).
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
				),
			)
			.for("update");
		for (const line of lines)
			await tx
				.update(purchaseOrderLines)
				.set({
					unit,
					packSize,
					quantity: Math.ceil((line.quantity * line.packSize) / packSize),
					unitCost:
						line.unitCost === null
							? null
							: perPack(line.unitCost, line.packSize, packSize),
				})
				.where(eq(purchaseOrderLines.id, line.id));
	});
}

function drafts(db: Db) {
	return db
		.select({ id: purchaseOrders.id })
		.from(purchaseOrders)
		.where(eq(purchaseOrders.status, "draft"));
}
