import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrders,
	purchaseUnits,
	supplierOffers,
} from "#/db/schema";
import { convertBreaks, type PriceList, priceAt } from "#/purchasing/bulk";
import { putBulkPrices, takeBulkPrices } from "#/purchasing/bulk-prices";
import { setOfferTerms } from "#/purchasing/catalogs";
import {
	convertDiscounts,
	lockForEdit,
	PurchaseOrderError,
} from "#/purchasing/orders";
import { perPack } from "#/purchasing/pack";

// The units suppliers sell in, and which one each sells each product in.
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

// Every unit with how many products some supplier sells in it. EACH first.
export async function listUnits(db: Db) {
	const rows = await db
		.select({
			name: purchaseUnits.name,
			products: sql<number>`(select count(distinct ps.product_id) from product_suppliers ps where ps.unit = "purchase_units"."name")::int`,
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
			.selectDistinct({ sku: products.sku })
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
// `lists`, when the supplier's price list moves to these terms with it, keeps
// a line that was at the list price on it: rounding up may reach a bulk
// price the old quantity didn't.
async function convertLine(
	db: Db,
	line: {
		id: number;
		quantity: number;
		packSize: number;
		unitCost: number | null;
	},
	t: UnitTerms,
	lists?: Lists,
) {
	const quantity = Math.max(
		Math.ceil((line.quantity * line.packSize) / t.packSize),
		t.minimumQuantity,
	);
	const listed =
		lists !== undefined &&
		line.packSize === lists.before.packSize &&
		line.unitCost === priceAt(lists.before, line.quantity);
	await db
		.update(purchaseOrderLines)
		.set({
			...t,
			quantity,
			unitCost: listed
				? priceAt(lists.after, quantity)
				: line.unitCost === null
					? null
					: perPack(line.unitCost, line.packSize, t.packSize),
		})
		.where(eq(purchaseOrderLines.id, line.id));
	await convertDiscounts(db, line, t.packSize);
}

// A supplier's price list for a product before and after its terms change.
type Lists = {
	before: PriceList & { packSize: number };
	after: PriceList;
};

// Sets a supplier's default terms for a product, converting its price and
// bulk prices to the new pack size. A bulk price every order now reaches
// becomes the price, so it isn't lost. Returns the terms as they were, and
// the price list before and after.
async function setDefaultTerms(
	db: Db,
	productId: number,
	supplierId: number,
	t: UnitTerms,
) {
	// The row is made first if it's missing (EACH, no price), so the lock
	// holds it: a price saved or received meanwhile can't be overwritten by
	// one read before it existed. Only a supplier that sells it gets one.
	await db.execute(sql`
		insert into ${productSuppliers} (product_id, supplier_id, supplier_count)
		select ${supplierOffers.productId}, ${supplierOffers.supplierId}, 1
		from ${supplierOffers}
		where ${supplierOffers.productId} = ${productId}
			and ${supplierOffers.supplierId} = ${supplierId}
		on conflict do nothing`);
	const [link] = await db
		.select()
		.from(productSuppliers)
		.where(
			and(
				eq(productSuppliers.productId, productId),
				eq(productSuppliers.supplierId, supplierId),
			),
		)
		.for("update");
	const packSize = link?.packSize ?? 1;
	const cost = link?.cost ?? null;
	// Bulk prices are pinned to the pack size, so they come off before it
	// changes and go back on converted.
	const held = await takeBulkPrices(db, productId, supplierId);
	const { breaks, floor } = convertBreaks(
		held,
		packSize,
		t.packSize,
		t.minimumQuantity,
	);
	const scaled = cost === null ? null : perPack(cost, packSize, t.packSize);
	const newCost =
		floor === null ? scaled : scaled === null ? floor : Math.min(scaled, floor);
	const was = await setOfferTerms(db, productId, supplierId, {
		...t,
		cost: newCost,
	});
	await putBulkPrices(db, productId, supplierId, t.packSize, breaks);
	const lists: Lists = {
		before: { packSize, cost, breaks: held },
		after: { cost: newCost, breaks },
	};
	return { was, lists };
}

// Changes what one draft PO orders a product in, and the minimum shown on
// it. With makeDefault, the PO's supplier keeps the same terms for it, so
// its later POs start from them; that needs the supplier to still sell it.
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
		if (!makeDefault) return convertLine(tx, line, terms);
		const { lists } = await setDefaultTerms(
			tx,
			productId,
			po.supplierId,
			terms,
		);
		await convertLine(tx, line, terms, lists);
	});
}

// Sets a supplier's default terms for a product, e.g. from its product
// page. Only that supplier's drafts are touched. Draft lines still on the old default follow it; a draft line given
// its own terms keeps them.
export async function setPurchaseUnit(
	db: Db,
	input: UnitTerms & { productId: number; supplierId: number },
) {
	const { productId, supplierId, ...terms } = input;
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
					eq(purchaseOrders.supplierId, supplierId),
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
		const { was: old, lists } = await setDefaultTerms(
			tx,
			productId,
			supplierId,
			terms,
		);
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
					eq(purchaseOrders.supplierId, supplierId),
					eq(purchaseOrderLines.unit, old.unit),
					eq(purchaseOrderLines.packSize, old.packSize),
					eq(purchaseOrderLines.supplierCount, old.supplierCount),
					eq(purchaseOrderLines.minimumQuantity, old.minimumQuantity),
				),
			)
			.for("update");
		for (const line of lines) await convertLine(tx, line, terms, lists);
	});
}

function drafts(db: Db) {
	return db
		.select({ id: purchaseOrders.id })
		.from(purchaseOrders)
		.where(eq(purchaseOrders.status, "draft"));
}
