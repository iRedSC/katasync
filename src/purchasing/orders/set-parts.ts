import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "#/db/client";
import {
	productComponents,
	products,
	purchaseOrderLines,
	purchaseOrderSentSets,
	purchaseOrderSkippedParts,
	purchaseOrders,
	supplierOffers,
	suppliers,
} from "#/db/schema";
import { setsOf } from "#/purchasing/sets";
import { newLine } from "./lines";
import { PurchaseOrderError } from "./lock";

// How many single items of each part a draft's tool set lines come to: the
// parts bought from the draft's supplier (their cheapest) that it doesn't skip. Kits on a PO
// are bought whole, so only sets count. Matches partState's "here".
export async function partsOfSets(
	db: Db,
	purchaseOrderId: number,
): Promise<Map<number, number>> {
	const rows = await db
		.select({
			productId: productComponents.componentProductId,
			items: sql<number>`(${purchaseOrderLines.quantity} * ${purchaseOrderLines.packSize} * ${productComponents.quantity})::int`,
		})
		.from(purchaseOrderLines)
		.innerJoin(
			purchaseOrders,
			eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
		)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.innerJoin(
			productComponents,
			eq(productComponents.parentProductId, purchaseOrderLines.productId),
		)
		.innerJoin(
			supplierOffers,
			and(
				eq(supplierOffers.productId, productComponents.componentProductId),
				eq(supplierOffers.supplierId, purchaseOrders.supplierId),
				eq(supplierOffers.cheapest, true),
			),
		)
		.leftJoin(
			purchaseOrderSkippedParts,
			and(
				eq(
					purchaseOrderSkippedParts.purchaseOrderId,
					purchaseOrderLines.purchaseOrderId,
				),
				eq(
					purchaseOrderSkippedParts.setProductId,
					purchaseOrderLines.productId,
				),
				eq(
					purchaseOrderSkippedParts.partProductId,
					productComponents.componentProductId,
				),
			),
		)
		.where(
			and(
				eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
				eq(products.kind, "bundle"),
				isNull(purchaseOrderSkippedParts.purchaseOrderId),
			),
		);
	const parts = new Map<number, number>();
	for (const r of rows)
		parts.set(r.productId, (parts.get(r.productId) ?? 0) + r.items);
	return parts;
}

// Replaces a draft's tool set lines with the parts it orders (partsOfSets),
// added onto the parts' own lines when the draft has them. Runs as it's sent, so the supplier and
// receiving only ever see things that are bought and shelved.
export async function splitSets(db: Db, purchaseOrderId: number) {
	const sets = await db
		.select({
			id: purchaseOrderLines.id,
			productId: purchaseOrderLines.productId,
			sets: sql<number>`(${purchaseOrderLines.quantity} * ${purchaseOrderLines.packSize})::int`,
		})
		.from(purchaseOrderLines)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.where(
			and(
				eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
				eq(products.kind, "bundle"),
			),
		);
	if (sets.length === 0) return;
	const parts = await partsOfSets(db, purchaseOrderId);
	// Kept, so the set's other suppliers' drafts know these parts are ordered.
	await db.insert(purchaseOrderSentSets).values(
		sets.map((s) => ({
			purchaseOrderId,
			setProductId: s.productId,
			sets: s.sets,
		})),
	);
	await db.delete(purchaseOrderLines).where(
		inArray(
			purchaseOrderLines.id,
			sets.map((s) => s.id),
		),
	);
	await addItemsBatch(db, purchaseOrderId, parts);
}

// The parts of a draft's tool set lines, for showing under each set: how many
// single items one set needs, who the part is bought from (its cheapest), whether this PO
// skips it, the unit and price it will land in when sent (its line on this
// PO, else the supplier's), and which of its supplier's other open POs have
// the set for it. partState in src/purchasing/sets.ts sorts them out.
export async function setPartsOf(db: Db, poId: number) {
	const part = alias(products, "part");
	const partLine = alias(purchaseOrderLines, "part_line");
	const rows = await db
		.select({
			lineId: purchaseOrderLines.id,
			setProductId: purchaseOrderLines.productId,
			productId: part.id,
			sku: part.sku,
			name: part.name,
			variantName: part.variantName,
			imageUrl: part.imageUrl,
			supplierSku: supplierOffers.supplierSku,
			perSet: productComponents.quantity,
			supplierId: supplierOffers.supplierId,
			supplierName: suppliers.name,
			skipped: sql<boolean>`${purchaseOrderSkippedParts.purchaseOrderId} is not null`,
			unit: sql<string>`coalesce(${partLine.unit}, ${supplierOffers.unit}, 'EACH')`,
			packSize: sql<number>`coalesce(${partLine.packSize}, ${supplierOffers.packSize}, 1)::int`,
			supplierCount: sql<number>`coalesce(${partLine.supplierCount}, ${supplierOffers.supplierCount}, 1)::int`,
			minimumQuantity: sql<number>`coalesce(${partLine.minimumQuantity}, ${supplierOffers.minimumQuantity}, 1)::int`,
			partLineId: partLine.id,
			lineCost: partLine.unitCost,
			supplierCost: supplierOffers.cost,
		})
		.from(purchaseOrderLines)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.innerJoin(
			productComponents,
			eq(productComponents.parentProductId, purchaseOrderLines.productId),
		)
		.innerJoin(part, eq(part.id, productComponents.componentProductId))
		.leftJoin(
			supplierOffers,
			and(
				eq(supplierOffers.productId, part.id),
				eq(supplierOffers.cheapest, true),
			),
		)
		.leftJoin(suppliers, eq(suppliers.id, supplierOffers.supplierId))
		.leftJoin(
			purchaseOrderSkippedParts,
			and(
				eq(purchaseOrderSkippedParts.purchaseOrderId, poId),
				eq(
					purchaseOrderSkippedParts.setProductId,
					purchaseOrderLines.productId,
				),
				eq(purchaseOrderSkippedParts.partProductId, part.id),
			),
		)
		.leftJoin(
			partLine,
			and(eq(partLine.purchaseOrderId, poId), eq(partLine.productId, part.id)),
		)
		.where(
			and(
				eq(purchaseOrderLines.purchaseOrderId, poId),
				eq(products.kind, "bundle"),
			),
		)
		.orderBy(part.name, part.variantName);
	const setIds = [...new Set(rows.map((r) => r.setProductId))];
	const others =
		setIds.length === 0 ? [] : await setsElsewhere(db, poId, setIds);
	const skips =
		others.length === 0
			? []
			: await db
					.select()
					.from(purchaseOrderSkippedParts)
					.where(
						and(
							inArray(
								purchaseOrderSkippedParts.purchaseOrderId,
								others.map((o) => o.purchaseOrderId),
							),
							inArray(purchaseOrderSkippedParts.setProductId, setIds),
						),
					);
	const skippedThere = new Set(
		skips.map(
			(s) => `${s.purchaseOrderId}:${s.setProductId}:${s.partProductId}`,
		),
	);
	return rows.map(({ partLineId, lineCost, supplierCost, ...r }) => ({
		...r,
		// What a new line would cost (see newLine), unless it has one already.
		unitCost: partLineId !== null ? lineCost : supplierCost,
		elsewhere: others
			.filter(
				(o) =>
					o.supplierId === r.supplierId &&
					o.setProductId === r.setProductId &&
					!skippedThere.has(
						`${o.purchaseOrderId}:${r.setProductId}:${r.productId}`,
					),
			)
			.map(({ purchaseOrderId, status, sets }) => ({
				purchaseOrderId,
				status,
				sets,
			})),
	}));
}

// The sets on every other open PO: on drafts as lines, on sent POs as they
// were when sent.
async function setsElsewhere(db: Db, poId: number, setIds: number[]) {
	const [drafts, sent] = await Promise.all([
		db
			.select({
				purchaseOrderId: purchaseOrders.id,
				supplierId: purchaseOrders.supplierId,
				setProductId: purchaseOrderLines.productId,
				sets: sql<number>`(${purchaseOrderLines.quantity} * ${purchaseOrderLines.packSize})::int`,
			})
			.from(purchaseOrderLines)
			.innerJoin(
				purchaseOrders,
				eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
			)
			.where(
				and(
					eq(purchaseOrders.status, "draft"),
					ne(purchaseOrders.id, poId),
					inArray(purchaseOrderLines.productId, setIds),
				),
			),
		db
			.select({
				purchaseOrderId: purchaseOrders.id,
				supplierId: purchaseOrders.supplierId,
				setProductId: purchaseOrderSentSets.setProductId,
				sets: purchaseOrderSentSets.sets,
			})
			.from(purchaseOrderSentSets)
			.innerJoin(
				purchaseOrders,
				eq(purchaseOrders.id, purchaseOrderSentSets.purchaseOrderId),
			)
			.where(
				and(
					eq(purchaseOrders.status, "sent"),
					ne(purchaseOrders.id, poId),
					inArray(purchaseOrderSentSets.setProductId, setIds),
				),
			),
	]);
	return [
		...drafts.map((d) => ({ ...d, status: "draft" as const })),
		...sent.map((s) => ({ ...s, status: "sent" as const })),
	];
}

// The draft PO a set line is on, and the line's parts.
export async function setLineParts(db: Db, lineId: number) {
	const [line] = await db
		.select({
			purchaseOrderId: purchaseOrderLines.purchaseOrderId,
			supplierId: purchaseOrders.supplierId,
			setProductId: purchaseOrderLines.productId,
			sku: products.sku,
			kind: products.kind,
			quantity: purchaseOrderLines.quantity,
			packSize: purchaseOrderLines.packSize,
		})
		.from(purchaseOrderLines)
		.innerJoin(
			purchaseOrders,
			eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
		)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.where(eq(purchaseOrderLines.id, lineId));
	if (!line) throw new PurchaseOrderError("That line doesn't exist");
	if (line.kind !== "bundle")
		throw new PurchaseOrderError(`${line.sku} isn't a tool set`);
	const parts = (await setPartsOf(db, line.purchaseOrderId)).filter(
		(p) => p.lineId === lineId,
	);
	return { ...line, sets: setsOf(line), parts };
}

// Adds single items of several products to a draft: each product's items go
// onto its line in that line's unit, rounded up to whole units, or onto a new
// line in the supplier's unit. Existing lines are read once and updated in one
// statement, and new lines inserted in one, so a set with many parts costs a
// few statements, not a few per part. Runs under the draft's lock.
export async function addItemsBatch(
	db: Db,
	purchaseOrderId: number,
	items: Map<number, number>,
) {
	if (items.size === 0) return;
	const [po] = await db
		.select({ supplierId: purchaseOrders.supplierId })
		.from(purchaseOrders)
		.where(eq(purchaseOrders.id, purchaseOrderId));
	if (!po) throw new Error(`PO ${purchaseOrderId} doesn't exist`);
	const lines = await db
		.select({
			id: purchaseOrderLines.id,
			productId: purchaseOrderLines.productId,
			quantity: purchaseOrderLines.quantity,
			packSize: purchaseOrderLines.packSize,
		})
		.from(purchaseOrderLines)
		.where(
			and(
				eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
				inArray(purchaseOrderLines.productId, [...items.keys()]),
			),
		);
	const onDraft = new Map(lines.map((l) => [l.productId, l]));
	const updates: { id: number; quantity: number }[] = [];
	const added: (typeof purchaseOrderLines.$inferInsert)[] = [];
	for (const [productId, count] of items) {
		const line = onDraft.get(productId);
		if (line) {
			updates.push({
				id: line.id,
				quantity: line.quantity + Math.ceil(count / line.packSize),
			});
			continue;
		}
		// A new line takes its terms and price from the supplier, one at a time.
		const { terms, unitCost } = await newLine(db, productId, po.supplierId);
		added.push({
			purchaseOrderId,
			productId,
			...terms,
			quantity: Math.ceil(count / terms.packSize),
			unitCost,
		});
	}
	if (updates.length > 0)
		await db.execute(sql`
			update ${purchaseOrderLines} set quantity = v.quantity
			from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
				as v(id integer, quantity integer)
			where ${purchaseOrderLines.id} = v.id`);
	if (added.length > 0) await db.insert(purchaseOrderLines).values(added);
}
