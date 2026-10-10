import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	stockLevels,
	suppliers,
} from "#/db/schema";
import { postMovements, undoBatch } from "#/inventory/ledger";
import { type SuggestedLine, suggestPurchases } from "#/purchasing/reorder";

// Every change to a PO goes through here. Each one locks the PO's row first,
// so two people receiving the same box can't both count it.

export class PurchaseOrderError extends Error {
	name = "PurchaseOrderError";
}

type Status = (typeof purchaseOrders.$inferSelect)["status"];

export const poName = (id: number) => `PO ${id}`;

async function lockOrder(db: Db, id: number, allowed: Status[]) {
	const [po] = await db
		.select()
		.from(purchaseOrders)
		.where(eq(purchaseOrders.id, id))
		.for("update");
	if (!po) throw new PurchaseOrderError(`${poName(id)} doesn't exist`);
	if (!allowed.includes(po.status))
		throw new PurchaseOrderError(`${poName(id)} is ${po.status}`);
	return po;
}

// Opens the supplier's draft with today's suggestions in it, creating it if
// there isn't one.
export async function draftFromSuggestions(
	db: Db,
	supplierId: number,
	now = new Date(),
): Promise<number> {
	const id = await openDraft(db, supplierId);
	await updateFromSuggestions(db, id, now);
	return id;
}

// How today's suggestions differ from a draft. A draft is frozen once made:
// these are what "Update" would apply. New products are added, and lines the
// suggestion now wants more of are raised. Nothing is lowered or removed, so
// a quantity set by hand is never undone.
export function draftChanges(
	draft: { productId: number; quantity: number }[],
	suggested: SuggestedLine[],
) {
	const onDraft = new Map(draft.map((l) => [l.productId, l.quantity]));
	return {
		added: suggested.filter((l) => !onDraft.has(l.productId)),
		raised: suggested.filter((l) => {
			const quantity = onDraft.get(l.productId);
			return quantity !== undefined && l.quantity > quantity;
		}),
	};
}

// Applies draftChanges to a draft. Returns how many lines it added and raised.
export async function updateFromSuggestions(
	db: Db,
	purchaseOrderId: number,
	now = new Date(),
): Promise<{ added: number; raised: number }> {
	const suggestions = await suggestPurchases(db, now);
	return db.transaction(async (tx) => {
		// Locked, so it can't be sent or cancelled while lines change.
		const po = await lockOrder(tx, purchaseOrderId, ["draft"]);
		const suggested =
			suggestions.find((s) => s.supplierId === po.supplierId)?.lines ?? [];
		const current = await tx
			.select({
				productId: purchaseOrderLines.productId,
				quantity: purchaseOrderLines.quantity,
			})
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.purchaseOrderId, po.id));
		const { added, raised } = draftChanges(current, suggested);
		if (added.length > 0)
			await tx.insert(purchaseOrderLines).values(
				added.map((l) => ({
					purchaseOrderId: po.id,
					productId: l.productId,
					quantity: l.quantity,
					unitCost: l.unitCost,
				})),
			);
		for (const l of raised)
			await tx
				.update(purchaseOrderLines)
				.set({ quantity: l.quantity })
				.where(
					and(
						eq(purchaseOrderLines.purchaseOrderId, po.id),
						eq(purchaseOrderLines.productId, l.productId),
					),
				);
		return { added: added.length, raised: raised.length };
	});
}

// The supplier's draft, created empty if it doesn't exist. Delivered to the
// first of our own locations; it can be changed before sending.
export async function openDraft(db: Db, supplierId: number): Promise<number> {
	return db.transaction(async (tx) => {
		const [existing] = await tx
			.select({ id: purchaseOrders.id })
			.from(purchaseOrders)
			.where(
				and(
					eq(purchaseOrders.supplierId, supplierId),
					eq(purchaseOrders.status, "draft"),
				),
			);
		if (existing) return existing.id;
		const [location] = await tx
			.select({ id: locations.id })
			.from(locations)
			.where(eq(locations.kind, "owned"))
			.orderBy(locations.id)
			.limit(1);
		if (!location)
			throw new PurchaseOrderError("Add a location to deliver POs to first");
		const [po] = await tx
			.insert(purchaseOrders)
			.values({ supplierId, locationId: location.id })
			.onConflictDoNothing()
			.returning({ id: purchaseOrders.id });
		if (po) return po.id;
		// Someone else created it a moment ago.
		return openDraft(tx, supplierId);
	});
}

// Sets how many of a product a draft orders, adding the line if needed. 0
// removes it. Leaving out unitCost keeps the line's price, or starts a new line
// at the supplier's price.
export async function setDraftLine(
	db: Db,
	input: {
		purchaseOrderId: number;
		productId: number;
		quantity: number;
		unitCost?: number | null;
	},
) {
	if (!Number.isInteger(input.quantity) || input.quantity < 0)
		throw new PurchaseOrderError(
			`Quantity must be a whole number, got ${input.quantity}`,
		);
	if (input.unitCost != null && !(input.unitCost >= 0))
		throw new PurchaseOrderError(`Price can't be ${input.unitCost}`);
	return db.transaction(async (tx) => {
		const po = await lockOrder(tx, input.purchaseOrderId, ["draft"]);
		const where = and(
			eq(purchaseOrderLines.purchaseOrderId, po.id),
			eq(purchaseOrderLines.productId, input.productId),
		);
		if (input.quantity === 0) {
			await tx.delete(purchaseOrderLines).where(where);
			return;
		}
		const [product] = await tx
			.select({
				kind: products.kind,
				sku: products.sku,
				productCost: products.unitCost,
				supplierCost: productSuppliers.cost,
			})
			.from(products)
			.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
			.where(eq(products.id, input.productId));
		if (!product) throw new PurchaseOrderError("That product doesn't exist");
		if (product.kind === "bundle")
			throw new PurchaseOrderError(
				`${product.sku} is a tool set; order its parts instead`,
			);
		await tx
			.insert(purchaseOrderLines)
			.values({
				purchaseOrderId: po.id,
				productId: input.productId,
				quantity: input.quantity,
				unitCost:
					input.unitCost !== undefined
						? input.unitCost
						: (product.supplierCost ?? product.productCost),
			})
			.onConflictDoUpdate({
				target: [
					purchaseOrderLines.purchaseOrderId,
					purchaseOrderLines.productId,
				],
				set: {
					quantity: input.quantity,
					...(input.unitCost !== undefined ? { unitCost: input.unitCost } : {}),
				},
			});
	});
}

export async function updateDraft(
	db: Db,
	input: {
		purchaseOrderId: number;
		notes?: string | null;
		locationId?: number;
	},
) {
	return db.transaction(async (tx) => {
		await lockOrder(tx, input.purchaseOrderId, ["draft"]);
		if (input.locationId !== undefined) {
			const [location] = await tx
				.select({ kind: locations.kind })
				.from(locations)
				.where(eq(locations.id, input.locationId));
			if (location?.kind !== "owned")
				throw new PurchaseOrderError("POs can only go to our own locations");
		}
		await tx
			.update(purchaseOrders)
			.set({
				...(input.notes !== undefined
					? { notes: input.notes?.trim() || null }
					: {}),
				...(input.locationId !== undefined
					? { locationId: input.locationId }
					: {}),
			})
			.where(eq(purchaseOrders.id, input.purchaseOrderId));
	});
}

// Puts a draft on order. sentTo is where it went, or null when it was ordered
// some other way (phone, their website). `deliver`, when given, sends it and
// returns the address it went to. It runs inside the transaction with the PO
// locked and gets that transaction, so what it sends is exactly what's saved
// as sent; if it fails, the PO stays a draft.
export async function markSent(
	db: Db,
	input: {
		purchaseOrderId: number;
		sentTo?: string | null;
		now?: Date;
		deliver?: (tx: Db) => Promise<string>;
	},
): Promise<string | null> {
	const now = input.now ?? new Date();
	return db.transaction(async (tx) => {
		const po = await lockOrder(tx, input.purchaseOrderId, ["draft"]);
		const lines = await tx
			.select({ id: purchaseOrderLines.id })
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.purchaseOrderId, po.id));
		if (lines.length === 0)
			throw new PurchaseOrderError(`${poName(po.id)} has nothing on it`);
		const [supplier] = await tx
			.select({ leadTimeDays: suppliers.leadTimeDays })
			.from(suppliers)
			.where(eq(suppliers.id, po.supplierId));
		const sentTo = input.deliver
			? await input.deliver(tx)
			: (input.sentTo ?? null);
		await tx
			.update(purchaseOrders)
			.set({
				status: "sent",
				sentAt: now,
				sentTo,
				expectedAt: new Date(
					now.getTime() + supplier.leadTimeDays * 86_400_000,
				),
			})
			.where(eq(purchaseOrders.id, po.id));
		return sentTo;
	});
}

// What arrived for one line. Puts it on the shelf at the PO's location and
// folds its price into the product's average cost. Closes the PO once every
// line has arrived in full.
export async function receive(
	db: Db,
	input: { lineId: number; quantity: number },
) {
	if (!Number.isInteger(input.quantity) || input.quantity <= 0)
		throw new PurchaseOrderError(
			`Quantity must be a positive whole number, got ${input.quantity}`,
		);
	return db.transaction(async (tx) => {
		const [line] = await tx
			.select()
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		if (!line) throw new PurchaseOrderError("That line doesn't exist");
		const po = await lockOrder(tx, line.purchaseOrderId, ["sent"]);
		// Receipts of this product on other POs wait here, so each one averages
		// its price against stock and cost the last one left.
		await tx
			.select({ id: products.id })
			.from(products)
			.where(eq(products.id, line.productId))
			.for("update");

		const before = await ownedOnHand(tx, line.productId);
		const { batchId } = await postMovements(tx, {
			reference: poName(po.id),
			lines: [
				{
					productId: line.productId,
					locationId: po.locationId,
					delta: input.quantity,
					reason: "receipt",
				},
			],
		});
		const [receipt] = await tx
			.insert(purchaseOrderReceipts)
			.values({ lineId: line.id, quantity: input.quantity, batchId })
			.returning({ id: purchaseOrderReceipts.id });

		if (line.unitCost !== null) {
			await averageInCost(tx, {
				productId: line.productId,
				onHandBefore: before,
				quantity: input.quantity,
				unitCost: line.unitCost,
			});
		}
		const closed = await closeIfComplete(tx, po.id);
		return { receiptId: receipt.id, closed };
	});
}

// Takes a receipt back off the shelf, e.g. a mis-tap. Reopens the PO if that
// leaves something short. The average cost isn't unwound: later receipts
// correct it, and reconstructing it exactly isn't worth the bookkeeping.
export async function undoReceipt(db: Db, receiptId: number) {
	return db.transaction(async (tx) => {
		const [receipt] = await tx
			.select({
				id: purchaseOrderReceipts.id,
				lineId: purchaseOrderReceipts.lineId,
				quantity: purchaseOrderReceipts.quantity,
				batchId: purchaseOrderReceipts.batchId,
				undoesId: purchaseOrderReceipts.undoesId,
				purchaseOrderId: purchaseOrderLines.purchaseOrderId,
			})
			.from(purchaseOrderReceipts)
			.innerJoin(
				purchaseOrderLines,
				eq(purchaseOrderLines.id, purchaseOrderReceipts.lineId),
			)
			.where(eq(purchaseOrderReceipts.id, receiptId));
		if (!receipt || receipt.undoesId !== null)
			throw new PurchaseOrderError("Nothing to undo");
		const po = await lockOrder(tx, receipt.purchaseOrderId, ["sent", "closed"]);
		const [already] = await tx
			.select({ id: purchaseOrderReceipts.id })
			.from(purchaseOrderReceipts)
			.where(eq(purchaseOrderReceipts.undoesId, receipt.id));
		if (already) throw new PurchaseOrderError("Already undone");

		const { batchId } = await undoBatch(tx, receipt.batchId);
		await tx.insert(purchaseOrderReceipts).values({
			lineId: receipt.lineId,
			quantity: -receipt.quantity,
			batchId,
			undoesId: receipt.id,
		});
		if (po.status === "closed" && (await shortLines(tx, po.id)) > 0) {
			await tx
				.update(purchaseOrders)
				.set({ status: "sent", closedAt: null })
				.where(eq(purchaseOrders.id, po.id));
		}
	});
}

// Stops waiting for what hasn't arrived, e.g. the supplier is out of it.
export async function closeOrder(db: Db, id: number, now = new Date()) {
	return db.transaction(async (tx) => {
		await lockOrder(tx, id, ["sent"]);
		await tx
			.update(purchaseOrders)
			.set({ status: "closed", closedAt: now })
			.where(eq(purchaseOrders.id, id));
	});
}

// Calls a PO off. Once anything has arrived, close it instead.
export async function cancelOrder(db: Db, id: number, now = new Date()) {
	return db.transaction(async (tx) => {
		await lockOrder(tx, id, ["draft", "sent"]);
		const [{ received }] = await tx
			.select({
				received: sql<number>`coalesce(sum(${purchaseOrderReceipts.quantity}), 0)::int`,
			})
			.from(purchaseOrderReceipts)
			.innerJoin(
				purchaseOrderLines,
				eq(purchaseOrderLines.id, purchaseOrderReceipts.lineId),
			)
			.where(eq(purchaseOrderLines.purchaseOrderId, id));
		if (received > 0)
			throw new PurchaseOrderError(
				`Part of ${poName(id)} has arrived; close it instead`,
			);
		await tx
			.update(purchaseOrders)
			.set({ status: "cancelled", closedAt: now })
			.where(eq(purchaseOrders.id, id));
	});
}

async function closeIfComplete(db: Db, id: number) {
	if ((await shortLines(db, id)) > 0) return false;
	await db
		.update(purchaseOrders)
		.set({ status: "closed", closedAt: new Date() })
		.where(eq(purchaseOrders.id, id));
	return true;
}

// Lines that haven't fully arrived.
async function shortLines(db: Db, id: number) {
	const received = db
		.select({
			lineId: purchaseOrderReceipts.lineId,
			units: sql<number>`sum(${purchaseOrderReceipts.quantity})`.as("units"),
		})
		.from(purchaseOrderReceipts)
		.groupBy(purchaseOrderReceipts.lineId)
		.as("received");
	const [{ short }] = await db
		.select({
			short: sql<number>`count(*) filter (where ${purchaseOrderLines.quantity} > coalesce(${received.units}, 0))::int`,
		})
		.from(purchaseOrderLines)
		.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
		.where(eq(purchaseOrderLines.purchaseOrderId, id));
	return short;
}

async function ownedOnHand(db: Db, productId: number) {
	const owned = db
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "owned"));
	const [row] = await db
		.select({
			onHand: sql<number>`coalesce(sum(${stockLevels.onHand}), 0)::int`,
		})
		.from(stockLevels)
		.where(
			and(
				eq(stockLevels.productId, productId),
				inArray(stockLevels.locationId, owned),
			),
		);
	return row.onHand;
}

// Weighted average of what's on the shelf and what just arrived. Oversold
// units (negative stock) have no cost to average in, so they count as none.
// The supplier's price becomes the last price paid.
export function averageCost(p: {
	oldCost: number | null;
	onHandBefore: number;
	quantity: number;
	unitCost: number;
}) {
	const held = Math.max(0, p.onHandBefore);
	if (p.oldCost === null || held === 0) return p.unitCost;
	return (held * p.oldCost + p.quantity * p.unitCost) / (held + p.quantity);
}

async function averageInCost(
	db: Db,
	p: {
		productId: number;
		onHandBefore: number;
		quantity: number;
		unitCost: number;
	},
) {
	const [product] = await db
		.select({ unitCost: products.unitCost })
		.from(products)
		.where(eq(products.id, p.productId));
	const cost = averageCost({ ...p, oldCost: product.unitCost });
	await db
		.update(products)
		.set({ unitCost: Math.round(cost * 10_000) / 10_000 })
		.where(eq(products.id, p.productId));
	await db
		.update(productSuppliers)
		.set({ cost: p.unitCost })
		.where(eq(productSuppliers.productId, p.productId));
}

// The PO a ledger batch belongs to, when it's a receipt or a receipt's undo.
// Those must be undone on the PO, so its receipts and status stay right.
export async function purchaseOrderOfBatch(
	db: Db,
	batchId: string,
): Promise<number | null> {
	const [row] = await db
		.select({ id: purchaseOrderLines.purchaseOrderId })
		.from(purchaseOrderReceipts)
		.innerJoin(
			purchaseOrderLines,
			eq(purchaseOrderLines.id, purchaseOrderReceipts.lineId),
		)
		.where(eq(purchaseOrderReceipts.batchId, batchId));
	return row?.id ?? null;
}
