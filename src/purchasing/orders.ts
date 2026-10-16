import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	productComponents,
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrderMovedParts,
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

export async function lockOrder(db: Db, id: number, allowed: Status[]) {
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
// a quantity set by hand is never undone. A line may be in a different unit
// from the suggestion (set on just this PO), so amounts compare as the product
// itself, and a raise is in the line's unit, rounded up. fromSets is what the
// draft's tool sets will add of each part when it's sent (partsOfSets), so a
// part already coming in a set isn't ordered twice.
export function draftChanges(
	draft: { productId: number; quantity: number; packSize: number }[],
	suggested: SuggestedLine[],
	fromSets: Map<number, number> = new Map(),
) {
	const onDraft = new Map(draft.map((l) => [l.productId, l]));
	const added: SuggestedLine[] = [];
	const raised: (SuggestedLine & { raiseTo: number })[] = [];
	for (const l of suggested) {
		const want = l.quantity * l.packSize - (fromSets.get(l.productId) ?? 0);
		const line = onDraft.get(l.productId);
		if (!line) {
			if (want > 0)
				added.push({
					...l,
					quantity: Math.max(Math.ceil(want / l.packSize), l.minimumQuantity),
				});
		} else if (want > line.quantity * line.packSize)
			raised.push({ ...l, raiseTo: Math.ceil(want / line.packSize) });
	}
	return { added, raised };
}

// How many single items of each part a draft's tool set lines come to,
// leaving out parts moved to another supplier's draft. Kits on a PO are bought
// whole, so only sets count.
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
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.innerJoin(
			productComponents,
			eq(productComponents.parentProductId, purchaseOrderLines.productId),
		)
		.leftJoin(
			purchaseOrderMovedParts,
			and(
				eq(
					purchaseOrderMovedParts.purchaseOrderId,
					purchaseOrderLines.purchaseOrderId,
				),
				eq(purchaseOrderMovedParts.setProductId, purchaseOrderLines.productId),
				eq(
					purchaseOrderMovedParts.partProductId,
					productComponents.componentProductId,
				),
			),
		)
		.where(
			and(
				eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
				eq(products.kind, "bundle"),
				isNull(purchaseOrderMovedParts.purchaseOrderId),
			),
		);
	const parts = new Map<number, number>();
	for (const r of rows)
		parts.set(r.productId, (parts.get(r.productId) ?? 0) + r.items);
	return parts;
}

// Replaces a draft's tool set lines with their parts, added onto the parts'
// own lines when the draft has them. Runs as it's sent, so the supplier and
// receiving only ever see things that are bought and shelved.
async function splitSets(db: Db, purchaseOrderId: number) {
	const sets = await db
		.select({ id: purchaseOrderLines.id })
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
	await db.delete(purchaseOrderLines).where(
		inArray(
			purchaseOrderLines.id,
			sets.map((s) => s.id),
		),
	);
	for (const [productId, items] of parts)
		await addItems(db, purchaseOrderId, productId, items);
}

// Moves one part of a draft's tool set line to the draft of the supplier the
// part is bought from, opening one if there isn't one. This PO's set then
// leaves the part out. Moves what the set needs right now; changing the set's
// quantity later doesn't change what was moved. Returns the draft it went to.
export async function movePartToSupplier(
	db: Db,
	input: { lineId: number; productId: number },
): Promise<number> {
	const [link] = await db
		.select({ supplierId: productSuppliers.supplierId, sku: products.sku })
		.from(products)
		.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
		.where(eq(products.id, input.productId));
	if (!link) throw new PurchaseOrderError("That product doesn't exist");
	if (link.supplierId === null)
		throw new PurchaseOrderError(
			`${link.sku} has no supplier yet; set one on its page`,
		);
	const target = await openDraft(db, link.supplierId);
	return db.transaction(async (tx) => {
		const [found] = await tx
			.select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		if (!found) throw new PurchaseOrderError("That line doesn't exist");
		if (found.purchaseOrderId === target)
			throw new PurchaseOrderError(
				`${link.sku} is already bought from this PO's supplier`,
			);
		// Lowest first, so two moves between the same drafts can't deadlock.
		for (const id of [found.purchaseOrderId, target].sort((a, b) => a - b))
			await lockOrder(tx, id, ["draft"]);
		// Read under the lock, so it's the quantity the set has now.
		const [part] = await tx
			.select({
				setProductId: purchaseOrderLines.productId,
				items: sql<number>`(${purchaseOrderLines.quantity} * ${purchaseOrderLines.packSize} * ${productComponents.quantity})::int`,
			})
			.from(purchaseOrderLines)
			.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
			.innerJoin(
				productComponents,
				eq(productComponents.parentProductId, purchaseOrderLines.productId),
			)
			.where(
				and(
					eq(purchaseOrderLines.id, input.lineId),
					eq(products.kind, "bundle"),
					eq(productComponents.componentProductId, input.productId),
				),
			);
		if (!part)
			throw new PurchaseOrderError(`${link.sku} isn't part of that set`);
		const moved = await tx
			.insert(purchaseOrderMovedParts)
			.values({
				purchaseOrderId: found.purchaseOrderId,
				setProductId: part.setProductId,
				partProductId: input.productId,
			})
			.onConflictDoNothing()
			.returning();
		if (moved.length === 0)
			throw new PurchaseOrderError(`${link.sku} was already moved`);
		await addItems(tx, target, input.productId, part.items);
		return target;
	});
}

// Adds single items of a product to a draft: onto its line in that line's
// unit, rounded up to whole units, or as a new line in the supplier's unit.
async function addItems(
	db: Db,
	purchaseOrderId: number,
	productId: number,
	items: number,
) {
	const [line] = await db
		.select({
			id: purchaseOrderLines.id,
			quantity: purchaseOrderLines.quantity,
			packSize: purchaseOrderLines.packSize,
		})
		.from(purchaseOrderLines)
		.where(
			and(
				eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
				eq(purchaseOrderLines.productId, productId),
			),
		);
	if (line) {
		await db
			.update(purchaseOrderLines)
			.set({ quantity: line.quantity + Math.ceil(items / line.packSize) })
			.where(eq(purchaseOrderLines.id, line.id));
		return;
	}
	const { terms, unitCost } = await newLine(db, productId);
	await db.insert(purchaseOrderLines).values({
		purchaseOrderId,
		productId,
		...terms,
		quantity: Math.ceil(items / terms.packSize),
		unitCost,
	});
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
				packSize: purchaseOrderLines.packSize,
			})
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.purchaseOrderId, po.id));
		const { added, raised } = draftChanges(
			current,
			suggested,
			await partsOfSets(tx, po.id),
		);
		if (added.length > 0)
			await tx.insert(purchaseOrderLines).values(
				added.map((l) => ({
					purchaseOrderId: po.id,
					productId: l.productId,
					unit: l.unit,
					packSize: l.packSize,
					minimumQuantity: l.minimumQuantity,
					quantity: l.quantity,
					unitCost: l.unitCost,
				})),
			);
		for (const l of raised)
			await tx
				.update(purchaseOrderLines)
				.set({ quantity: l.raiseTo })
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
// removes it. A new line is in the supplier's unit (EACH when the product has
// no supplier). Leaving out unitCost keeps the line's price, or starts a new
// line at the supplier's price. With inItems, quantity counts single items and
// rounds up to whole packs of the line's pack size, read under the same lock
// as the write so a change to the terms can't slip in between. Returns the
// line's terms and the quantity it ended up with, in its unit. A tool set gets
// its own line here and is split into its parts when the PO is sent.
export async function setDraftLine(
	db: Db,
	input: {
		purchaseOrderId: number;
		productId: number;
		quantity: number;
		inItems?: boolean;
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
		const product = await newLine(tx, input.productId);
		// A line already on the draft keeps its own terms; a new one starts
		// with the supplier's.
		const [existing] = await tx
			.select({
				unit: purchaseOrderLines.unit,
				packSize: purchaseOrderLines.packSize,
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
		await tx
			.insert(purchaseOrderLines)
			.values({
				purchaseOrderId: po.id,
				productId: input.productId,
				...terms,
				quantity,
				// A new line's terms are the supplier's, so its price is too.
				unitCost:
					input.unitCost !== undefined ? input.unitCost : product.unitCost,
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
			});
		return { ...terms, quantity };
	});
}

// What a new line for the product starts with: the supplier's terms (EACH
// when it has no supplier) and price.
async function newLine(tx: Db, productId: number) {
	const [product] = await tx
		.select({
			kind: products.kind,
			sku: products.sku,
			productCost: products.unitCost,
			supplierCost: productSuppliers.cost,
			unit: productSuppliers.unit,
			packSize: productSuppliers.packSize,
			minimumQuantity: productSuppliers.minimumQuantity,
		})
		.from(products)
		.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
		.where(eq(products.id, productId));
	if (!product) throw new PurchaseOrderError("That product doesn't exist");
	const packSize = product.packSize ?? 1;
	return {
		kind: product.kind,
		sku: product.sku,
		terms: {
			unit: product.unit ?? "EACH",
			packSize,
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
			`${product.sku} is a tool set with no parts yet; add them on its page`,
		);
}

// Everything about a line someone can change. Undoing an add compares all of
// it, so an edit made since is never thrown away.
const lineFields = {
	id: purchaseOrderLines.id,
	unit: purchaseOrderLines.unit,
	packSize: purchaseOrderLines.packSize,
	minimumQuantity: purchaseOrderLines.minimumQuantity,
	quantity: purchaseOrderLines.quantity,
	unitCost: purchaseOrderLines.unitCost,
};
export type AddedLine = {
	id: number;
	unit: string;
	packSize: number;
	minimumQuantity: number;
	quantity: number;
	unitCost: number | null;
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
	input: { purchaseOrderId: number; productId: number; quantity: number },
	allowed: Status[] = ["draft", "sent", "closed"],
): Promise<{ added: boolean; line: AddedLine }> {
	if (!Number.isInteger(input.quantity) || input.quantity <= 0)
		throw new PurchaseOrderError(
			`Quantity must be a whole number above 0, got ${input.quantity}`,
		);
	return db.transaction(async (tx) => {
		const po = await lockOrder(tx, input.purchaseOrderId, allowed);
		return insertLine(tx, po, input);
	});
}

// Adds the line under the PO's lock, unless the product's already on it.
async function insertLine(
	tx: Db,
	po: typeof purchaseOrders.$inferSelect,
	input: { productId: number; quantity: number },
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
		await lockOrder(tx, input.purchaseOrderId, ["draft"]);
		const removed = await tx
			.delete(purchaseOrderLines)
			.where(
				and(
					eq(purchaseOrderLines.id, line.id),
					eq(purchaseOrderLines.purchaseOrderId, input.purchaseOrderId),
					eq(purchaseOrderLines.unit, line.unit),
					eq(purchaseOrderLines.packSize, line.packSize),
					eq(purchaseOrderLines.minimumQuantity, line.minimumQuantity),
					eq(purchaseOrderLines.quantity, line.quantity),
					line.unitCost === null
						? isNull(purchaseOrderLines.unitCost)
						: eq(purchaseOrderLines.unitCost, line.unitCost),
					// Moving one of a set's parts is a change too.
					notExists(
						tx
							.select({ id: purchaseOrderMovedParts.partProductId })
							.from(purchaseOrderMovedParts)
							.where(
								and(
									eq(
										purchaseOrderMovedParts.purchaseOrderId,
										input.purchaseOrderId,
									),
									eq(
										purchaseOrderMovedParts.setProductId,
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
		await splitSets(tx, po.id);
		const lines = await tx
			.select({ id: purchaseOrderLines.id })
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.purchaseOrderId, po.id));
		if (lines.length === 0)
			throw new PurchaseOrderError(`${poName(po.id)} has nothing on it`);
		// Saved before the PDF is built, so it prints exactly these.
		await tx
			.update(purchaseOrderLines)
			.set({
				sentQuantity: purchaseOrderLines.quantity,
				sentUnitCost: purchaseOrderLines.unitCost,
			})
			.where(eq(purchaseOrderLines.purchaseOrderId, po.id));
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

// What arrived for one line, in the line's unit: 2 cases of 30 puts 60 on the
// shelf at the PO's location. Folds its price into the product's average cost.
// Closes the PO once every line has arrived in full.
// More than expected means the supplier sent extra and we're keeping it, so
// the line now expects what arrived. `last` says nothing more is coming, so
// the line expects only what arrived. Either change is saved on the receipt,
// so undoing it puts the line back. Neither reaches the supplier.
export async function receive(
	db: Db,
	input: { lineId: number; quantity: number; last?: boolean },
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
					delta: input.quantity * line.packSize,
					reason: "receipt",
				},
			],
		});
		const total = (await receivedOf(tx, line.id)) + input.quantity;
		const expect =
			total > line.quantity || (input.last && total < line.quantity)
				? total
				: null;
		if (expect !== null)
			await tx
				.update(purchaseOrderLines)
				.set({ quantity: expect })
				.where(eq(purchaseOrderLines.id, line.id));
		const [receipt] = await tx
			.insert(purchaseOrderReceipts)
			.values({
				lineId: line.id,
				quantity: input.quantity,
				batchId,
				...(expect !== null
					? { quantityBefore: line.quantity, quantityAfter: expect }
					: {}),
			})
			.returning({ id: purchaseOrderReceipts.id });

		if (line.unitCost !== null) {
			await averageInCost(tx, {
				productId: line.productId,
				onHandBefore: before,
				quantity: input.quantity * line.packSize,
				unitCost: line.unitCost / line.packSize,
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
				quantityBefore: purchaseOrderReceipts.quantityBefore,
				quantityAfter: purchaseOrderReceipts.quantityAfter,
				lineQuantity: purchaseOrderLines.quantity,
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
		// Only when nobody has changed the quantity since.
		if (
			receipt.quantityBefore !== null &&
			receipt.lineQuantity === receipt.quantityAfter
		)
			await tx
				.update(purchaseOrderLines)
				.set({ quantity: receipt.quantityBefore })
				.where(eq(purchaseOrderLines.id, receipt.lineId));
		if (po.status === "closed" && (await shortLines(tx, po.id)) > 0)
			await reopen(tx, po.id);
	});
}

// Something arrived that isn't on the PO, or more of something that is:
// it's added if needed and received in one go, so it can't be left half
// done. Expecting nothing before the receipt, undoing it leaves the line
// expecting nothing. Works on a closed PO too, since the box may hold more
// after everything else is in.
export async function receiveExtra(
	db: Db,
	input: { purchaseOrderId: number; productId: number; quantity: number },
) {
	return db.transaction(async (tx) => {
		const po = await lockOrder(tx, input.purchaseOrderId, ["sent", "closed"]);
		const { line } = await insertLine(tx, po, {
			productId: input.productId,
			quantity: 0,
		});
		if (po.status === "closed") await reopen(tx, po.id);
		const result = await receive(tx, {
			lineId: line.id,
			quantity: input.quantity,
		});
		return { ...result, lineId: line.id };
	});
}

// Changes a sent line without telling the supplier: we're keeping what they
// got wrong. The PDF still shows what was sent. A quantity can't go under
// what's already arrived; 0 means none are coming. A line added after
// sending that never received anything is taken off instead of kept at 0.
// Returns what the line was, for undo, and whether stock had already come in
// at the old cost, which keeps that cost.
export async function amendLine(
	db: Db,
	input: { lineId: number; quantity?: number; unitCost?: number | null },
) {
	if (
		input.quantity !== undefined &&
		!(Number.isInteger(input.quantity) && input.quantity >= 0)
	)
		throw new PurchaseOrderError(
			`Quantity must be a whole number, got ${input.quantity}`,
		);
	if (input.unitCost != null && !(input.unitCost >= 0))
		throw new PurchaseOrderError(`Price can't be ${input.unitCost}`);
	return db.transaction(async (tx) => {
		const [found] = await tx
			.select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		if (!found) throw new PurchaseOrderError("That line doesn't exist");
		const po = await lockOrder(tx, found.purchaseOrderId, ["sent", "closed"]);
		const [line] = await tx
			.select()
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		const received = await receivedOf(tx, line.id);
		const was = { quantity: line.quantity, unitCost: line.unitCost };
		const quantity = input.quantity ?? line.quantity;
		if (quantity < received)
			throw new PurchaseOrderError(
				`${received} already arrived; undo a receipt to go lower`,
			);
		if (quantity === 0 && line.sentQuantity === null) {
			const [receipt] = await tx
				.select({ id: purchaseOrderReceipts.id })
				.from(purchaseOrderReceipts)
				.where(eq(purchaseOrderReceipts.lineId, line.id))
				.limit(1);
			if (!receipt) {
				await tx
					.delete(purchaseOrderLines)
					.where(eq(purchaseOrderLines.id, line.id));
				await settle(tx, po, null);
				return { was, removed: true, receivedAtOldCost: false };
			}
		}
		await tx
			.update(purchaseOrderLines)
			.set({
				quantity,
				...(input.unitCost !== undefined ? { unitCost: input.unitCost } : {}),
			})
			.where(eq(purchaseOrderLines.id, line.id));
		if (quantity !== line.quantity) await settle(tx, po, quantity > received);
		return {
			was,
			removed: false,
			receivedAtOldCost:
				input.unitCost !== undefined &&
				input.unitCost !== line.unitCost &&
				received > 0,
		};
	});
}

// After a line's quantity changes: a sent PO with everything in closes, and
// a closed one reopens when the changed line is now waiting on more. `short`
// is whether it is, or null when the line was taken off.
async function settle(
	tx: Db,
	po: typeof purchaseOrders.$inferSelect,
	short: boolean | null,
) {
	if (po.status === "sent") await closeIfComplete(tx, po.id);
	else if (po.status === "closed" && short) await reopen(tx, po.id);
}

async function reopen(tx: Db, id: number) {
	await tx
		.update(purchaseOrders)
		.set({ status: "sent", closedAt: null })
		.where(eq(purchaseOrders.id, id));
}

async function receivedOf(tx: Db, lineId: number) {
	const [row] = await tx
		.select({
			units: sql<number>`coalesce(sum(${purchaseOrderReceipts.quantity}), 0)::int`,
		})
		.from(purchaseOrderReceipts)
		.where(eq(purchaseOrderReceipts.lineId, lineId));
	return row.units;
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

// Calls a PO off. Once anything has arrived, close it instead. `allowed` is
// checked under the lock, so a caller limiting itself to drafts can't cancel a
// PO that was sent a moment ago.
export async function cancelOrder(
	db: Db,
	id: number,
	now = new Date(),
	allowed: Status[] = ["draft", "sent"],
) {
	return db.transaction(async (tx) => {
		await lockOrder(tx, id, allowed);
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

// Weighted average of what's on the shelf and what just arrived, per one of
// the product. Oversold units (negative stock) have no cost to average in, so
// they count as none. The supplier's price becomes the last price paid, in
// whatever unit the product is bought in now.
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
	// One statement, so the pack size it multiplies by is the row's current one
	// even if a new default is being saved at the same time. Same rounding as
	// perPack.
	await db
		.update(productSuppliers)
		.set({
			cost: sql`round(${p.unitCost}::numeric * ${productSuppliers.packSize}, 4)`,
		})
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
