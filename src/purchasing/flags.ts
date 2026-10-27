import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	poFlags,
	products,
	purchaseOrderLines,
	purchaseOrders,
} from "#/db/schema";
import type { FlagInput } from "#/purchasing/inbox/ai-filing-shapes";
import {
	amendLine,
	lockOrder,
	PurchaseOrderError,
	setBackOrdered,
} from "#/purchasing/orders";

// Flags on sent POs: what a supplier's email says should change (a price, a
// quantity, a line back-ordered, or anything in words), raised by the AI,
// Claude, or staff. Nothing changes the PO until someone applies one, which
// makes the change and keeps what it replaced, so reopening sets it back.

type By = "ai" | "claude" | "staff";

// POs a supplier can still write about. Cancelled ones take nothing.
const FLAGGABLE = ["sent", "closed"] as const;

// The line of a PO with that SKU, or why there's none.
export async function lineFor(db: Db, purchaseOrderId: number, sku: string) {
	const [line] = await db
		.select({
			id: purchaseOrderLines.id,
			productId: purchaseOrderLines.productId,
			sku: products.sku,
		})
		.from(purchaseOrderLines)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.where(
			and(
				eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
				sql`lower(${products.sku}) = lower(${sku.trim()})`,
			),
		);
	if (!line)
		throw new PurchaseOrderError(`${sku} isn't on PO ${purchaseOrderId}`);
	return line;
}

// Raises a flag, or for a product that has an open one of its kind, replaces
// it with this one.
export async function raiseFlag(
	db: Db,
	input: {
		purchaseOrderId: number;
		emailId?: number | null;
		by: By;
		flag: FlagInput;
	},
) {
	const { flag, purchaseOrderId } = input;
	const [po] = await db
		.select({ status: purchaseOrders.status })
		.from(purchaseOrders)
		.where(eq(purchaseOrders.id, purchaseOrderId));
	if (!po) throw new PurchaseOrderError(`There's no PO ${purchaseOrderId}`);
	if (!(FLAGGABLE as readonly string[]).includes(po.status))
		throw new PurchaseOrderError(
			`PO ${purchaseOrderId} is ${po.status}; only sent POs take flags`,
		);
	if (!flag.note.trim()) throw new PurchaseOrderError("Say why in the note");
	if (flag.kind !== "note" && !flag.sku.trim())
		throw new PurchaseOrderError(`A ${flag.kind} flag needs the line's sku`);
	const value = "value" in flag ? flag.value : null;
	if (
		flag.kind === "quantity" &&
		!(value !== null && Number.isInteger(value) && value >= 0)
	)
		throw new PurchaseOrderError(`A quantity can't be ${value}`);
	if (flag.kind === "price" && !(value !== null && value >= 0))
		throw new PurchaseOrderError(`A price can't be ${value}`);
	const line = flag.sku ? await lineFor(db, purchaseOrderId, flag.sku) : null;
	const values = {
		purchaseOrderId,
		emailId: input.emailId ?? null,
		productId: line?.productId ?? null,
		kind: flag.kind,
		value,
		note: flag.note.trim(),
		by: input.by,
	};
	const [row] =
		flag.kind === "note"
			? await db.insert(poFlags).values(values).returning()
			: await db
					.insert(poFlags)
					.values(values)
					.onConflictDoUpdate({
						target: [poFlags.purchaseOrderId, poFlags.productId, poFlags.kind],
						targetWhere: sql`${poFlags.resolvedAt} is null and ${poFlags.kind} <> 'note'`,
						set: {
							value,
							note: values.note,
							emailId: values.emailId,
							by: input.by,
							createdAt: new Date(),
						},
					})
					.returning();
	return row;
}

const shown = {
	id: poFlags.id,
	purchaseOrderId: poFlags.purchaseOrderId,
	emailId: poFlags.emailId,
	kind: poFlags.kind,
	value: poFlags.value,
	note: poFlags.note,
	by: poFlags.by,
	createdAt: poFlags.createdAt,
	resolvedAt: poFlags.resolvedAt,
	resolution: poFlags.resolution,
	sku: products.sku,
	name: products.name,
	// What the line is now, to show beside what the flag says.
	unitCost: purchaseOrderLines.unitCost,
	quantity: purchaseOrderLines.quantity,
	unit: purchaseOrderLines.unit,
	backOrdered: sql<boolean>`${purchaseOrderLines.backOrderedAt} is not null`,
};

function flagRows(db: Db) {
	return db
		.select(shown)
		.from(poFlags)
		.leftJoin(products, eq(products.id, poFlags.productId))
		.leftJoin(
			purchaseOrderLines,
			and(
				eq(purchaseOrderLines.purchaseOrderId, poFlags.purchaseOrderId),
				eq(purchaseOrderLines.productId, poFlags.productId),
			),
		);
}

export type Flag = Awaited<ReturnType<typeof openFlagsOf>>[number];

// A PO's flags waiting on someone, oldest first.
export function openFlagsOf(db: Db, purchaseOrderId: number) {
	return flagRows(db)
		.where(
			and(
				eq(poFlags.purchaseOrderId, purchaseOrderId),
				isNull(poFlags.resolvedAt),
			),
		)
		.orderBy(poFlags.id);
}

// The flags read from these emails, open or not, newest first.
export async function flagsOfEmails(db: Db, emailIds: number[]) {
	if (emailIds.length === 0) return [];
	return flagRows(db)
		.where(inArray(poFlags.emailId, emailIds))
		.orderBy(desc(poFlags.id));
}

async function lockedFlag(tx: Db, id: number) {
	const [flag] = await tx
		.select()
		.from(poFlags)
		.where(eq(poFlags.id, id))
		.for("update");
	if (!flag) throw new PurchaseOrderError(`There's no flag ${id}`);
	return flag;
}

async function lineOfFlag(tx: Db, flag: typeof poFlags.$inferSelect) {
	const [line] = flag.productId
		? await tx
				.select({ id: purchaseOrderLines.id })
				.from(purchaseOrderLines)
				.where(
					and(
						eq(purchaseOrderLines.purchaseOrderId, flag.purchaseOrderId),
						eq(purchaseOrderLines.productId, flag.productId),
					),
				)
		: [];
	if (!line) throw new PurchaseOrderError("That line isn't on the PO anymore");
	return line;
}

// Applies a flag (makes the change it says) or dismisses it. A note has
// nothing to apply. All or nothing: a change the PO refuses leaves the flag
// open.
export async function resolveFlag(
	db: Db,
	input: { id: number; apply: boolean },
) {
	return db.transaction(async (tx) => {
		const flag = await lockedFlag(tx, input.id);
		if (flag.resolution)
			throw new PurchaseOrderError(`That flag was ${flag.resolution} already`);
		let before: number | null = null;
		if (input.apply) {
			if (flag.kind === "note")
				throw new PurchaseOrderError("A note has nothing to apply; dismiss it");
			const line = await lineOfFlag(tx, flag);
			if (flag.kind === "back_order") {
				const r = await setBackOrdered(tx, {
					lineId: line.id,
					backOrdered: true,
				});
				before = r.was ? 1 : 0;
			} else {
				const r = await amendLine(
					tx,
					flag.kind === "price"
						? { lineId: line.id, unitCost: flag.value }
						: { lineId: line.id, quantity: flag.value ?? undefined },
				);
				before = flag.kind === "price" ? r.was.unitCost : r.was.quantity;
			}
		}
		const [row] = await tx
			.update(poFlags)
			.set({
				resolvedAt: new Date(),
				resolution: input.apply ? "applied" : "dismissed",
				before,
			})
			.where(eq(poFlags.id, flag.id))
			.returning();
		return row;
	});
}

// Opens a resolved flag again, setting back what applying it changed. A
// line changed since is someone's newer decision: it's refused rather than
// overwritten.
export async function reopenFlag(db: Db, id: number) {
	return db.transaction(async (tx) => {
		const flag = await lockedFlag(tx, id);
		if (!flag.resolution) return flag;
		if (flag.resolution === "applied" && flag.kind !== "note") {
			// Locked before the line is read, so an edit can't land between
			// the check below and setting it back.
			await lockOrder(tx, flag.purchaseOrderId, [...FLAGGABLE]);
			const line = await lineOfFlag(tx, flag);
			const [now] = await tx
				.select()
				.from(purchaseOrderLines)
				.where(eq(purchaseOrderLines.id, line.id));
			if (flag.kind === "back_order") {
				if (flag.before === 0)
					await setBackOrdered(tx, { lineId: line.id, backOrdered: false });
			} else {
				const is = flag.kind === "price" ? now.unitCost : now.quantity;
				if (is !== flag.value)
					throw new PurchaseOrderError(
						`${flag.kind === "price" ? "The price" : "The quantity"} changed since; set it on the line`,
					);
				await amendLine(
					tx,
					flag.kind === "price"
						? { lineId: line.id, unitCost: flag.before }
						: { lineId: line.id, quantity: flag.before ?? undefined },
				);
			}
		}
		const [row] = await tx
			.update(poFlags)
			.set({ resolvedAt: null, resolution: null, before: null })
			.where(eq(poFlags.id, id))
			.returning();
		return row;
	});
}
