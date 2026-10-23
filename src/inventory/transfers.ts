import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, products, transferLines, transfers } from "#/db/schema";
import { transferStock, undoBatch } from "#/inventory/ledger";
import { lockStockProducts } from "#/inventory/ledger/post";
import { ourKinds } from "#/inventory/locations";
import {
	deliveryOf,
	dispatchTransfer,
	liveReceipts,
} from "./transfer-deliveries";

// A transfer is a draft until it's sent; sending moves every line at once.
// Undoing a send moves it all back and makes it a draft again, so it can be
// fixed and sent again. Shown as "T12".

export class TransferError extends Error {
	name = "TransferError";
}

export const transferName = (id: number) => `T${id}`;

// Lines written per statement, under Postgres's limit on parameters.
const BATCH = 500;

async function assertOurs(db: Db, ids: number[]) {
	const found = await db
		.select({ id: locations.id, kind: locations.kind })
		.from(locations)
		.where(inArray(locations.id, ids));
	for (const id of ids) {
		const l = found.find((f) => f.id === id);
		if (!l || !(ourKinds as readonly string[]).includes(l.kind))
			throw new TransferError("Transfers go only between our own locations");
	}
}

export async function createTransfer(
	db: Db,
	input: { fromLocationId: number; toLocationId: number; note?: string },
) {
	if (input.fromLocationId === input.toLocationId)
		throw new TransferError("Pick two different locations");
	await assertOurs(db, [input.fromLocationId, input.toLocationId]);
	const [made] = await db
		.insert(transfers)
		.values({
			fromLocationId: input.fromLocationId,
			toLocationId: input.toLocationId,
			note: input.note?.trim() || null,
		})
		.returning({ id: transfers.id });
	return made.id;
}

// Locks a transfer to change it. Only a draft changes.
export async function lockDraft(tx: Db, id: number) {
	const [t] = await tx
		.select()
		.from(transfers)
		.where(eq(transfers.id, id))
		.for("update");
	if (!t) throw new TransferError(`No transfer ${transferName(id)}`);
	if (t.status !== "draft")
		throw new TransferError(
			`${transferName(id)} was sent. Undo the send to change it.`,
		);
	return t;
}

// Sets how many of each product the draft moves; 0 takes a product off.
// Products not named stay as they are. Tool sets have no stock of their own,
// so they move as their parts. A product named twice takes its last quantity.
export async function setTransferLines(
	db: Db,
	id: number,
	lines: { productId: number; quantity: number }[],
) {
	for (const l of lines)
		if (!Number.isInteger(l.quantity) || l.quantity < 0)
			throw new TransferError("Quantities are whole numbers from 0");
	const wanted = new Map(lines.map((l) => [l.productId, l.quantity] as const));
	return db.transaction(async (tx) => {
		await lockDraft(tx, id);
		const ids = [...wanted.keys()];
		if (ids.length === 0) return;
		const found = await tx
			.select({ id: products.id, sku: products.sku, kind: products.kind })
			.from(products)
			.where(inArray(products.id, ids));
		const sets = found.filter((p) => p.kind === "bundle");
		if (sets.length > 0)
			throw new TransferError(
				`Tool sets move as their parts: ${sets.map((s) => s.sku).join(", ")}`,
			);
		if (found.length !== ids.length)
			throw new TransferError("Some of those products don't exist");
		const zero: number[] = [];
		const positive: {
			transferId: number;
			productId: number;
			quantity: number;
		}[] = [];
		for (const [productId, quantity] of wanted)
			if (quantity === 0) zero.push(productId);
			else positive.push({ transferId: id, productId, quantity });
		if (zero.length > 0)
			await tx
				.delete(transferLines)
				.where(
					and(
						eq(transferLines.transferId, id),
						inArray(transferLines.productId, zero),
					),
				);
		for (let i = 0; i < positive.length; i += BATCH)
			await tx
				.insert(transferLines)
				.values(positive.slice(i, i + BATCH))
				.onConflictDoUpdate({
					target: [transferLines.transferId, transferLines.productId],
					set: { quantity: sql`excluded.quantity` },
				});
	});
}

// A new draft with its lines, and what `fill` adds to it, in one transaction:
// when any of it fails, no draft is left behind.
export async function createDraftWith<T>(
	db: Db,
	input: {
		fromLocationId: number;
		toLocationId: number;
		note?: string;
		lines?: { productId: number; quantity: number }[];
	},
	fill: (tx: Db, id: number) => Promise<T>,
): Promise<{ id: number; filled: T }> {
	return db.transaction(async (tx) => {
		const id = await createTransfer(tx, input);
		if (input.lines) await setTransferLines(tx, id, input.lines);
		return { id, filled: await fill(tx, id) };
	});
}

// Changes a draft's note or direction. Swapping keeps the lines.
export async function updateTransfer(
	db: Db,
	id: number,
	input: { note?: string | null; swap?: boolean },
) {
	return db.transaction(async (tx) => {
		const t = await lockDraft(tx, id);
		await tx
			.update(transfers)
			.set({
				...(input.note !== undefined
					? { note: input.note?.trim() || null }
					: {}),
				...(input.swap
					? { fromLocationId: t.toLocationId, toLocationId: t.fromLocationId }
					: {}),
			})
			.where(eq(transfers.id, id));
	});
}

export async function deleteTransfer(db: Db, id: number) {
	return db.transaction(async (tx) => {
		await lockDraft(tx, id);
		await tx.delete(transfers).where(eq(transfers.id, id));
	});
}

async function draftLines(tx: Db, id: number) {
	const lines = await tx
		.select({
			productId: transferLines.productId,
			quantity: transferLines.quantity,
		})
		.from(transferLines)
		.where(eq(transferLines.transferId, id));
	if (lines.length === 0)
		throw new TransferError("Add what's moving before sending it");
	return lines;
}

export async function sendTransfer(db: Db, id: number) {
	return db.transaction(async (tx) => {
		const t = await lockDraft(tx, id);
		return dispatchTransfer(tx, t, await draftLines(tx, id));
	});
}

async function sendDirect(db: Db, id: number) {
	return db.transaction(async (tx) => {
		const t = await lockDraft(tx, id);
		const { batchId } = await transferStock(tx, {
			fromLocationId: t.fromLocationId,
			toLocationId: t.toLocationId,
			lines: await draftLines(tx, id),
			reference: `transfer:${id}`,
			note: t.note ?? undefined,
		});
		await tx
			.update(transfers)
			.set({ status: "sent", batchId, sentAt: new Date() })
			.where(eq(transfers.id, id));
		return { batchId };
	});
}

// Moves a sent transfer's stock back. It becomes a draft again, or with
// `discard` (a quick move undone) goes away.
export async function unsendTransfer(
	db: Db,
	id: number,
	options: { discard?: boolean } = {},
) {
	return db.transaction(async (tx) => {
		const [t] = await tx
			.select()
			.from(transfers)
			.where(eq(transfers.id, id))
			.for("update");
		if (!t) throw new TransferError(`No transfer ${transferName(id)}`);
		if (t.status !== "sent" || !t.batchId)
			throw new TransferError(`${transferName(id)} hasn't been sent`);
		const delivery = await deliveryOf(tx, id);
		if (liveReceipts(delivery).length > 0)
			throw new TransferError(
				`Some of ${transferName(id)} was received; undo those receipts first`,
			);
		const viaTransit = delivery.kind !== "completed";
		if (viaTransit && options.discard)
			throw new TransferError(
				`${transferName(id)} went through transit; undoing it makes it a draft`,
			);
		await undoBatch(tx, t.batchId);
		if (options.discard) {
			await tx.delete(transfers).where(eq(transfers.id, id));
			return;
		}
		await tx
			.update(transfers)
			.set({ status: "draft", batchId: null, sentAt: null })
			.where(eq(transfers.id, id));
	});
}

// One product moved now, as a sent transfer of one line, so it shows in the
// transfer history like any other (Move stock on the product page).
export async function moveNow(
	db: Db,
	input: {
		productId: number;
		fromLocationId: number;
		toLocationId: number;
		quantity: number;
		note?: string;
	},
) {
	return db.transaction(async (tx) => {
		await lockStockProducts(tx, [input.productId]);
		const id = await createTransfer(tx, input);
		await setTransferLines(tx, id, [
			{ productId: input.productId, quantity: input.quantity },
		]);
		const { batchId } = await sendDirect(tx, id);
		return { transferId: id, batchId };
	});
}

// The transfer a ledger batch was sent by, if any: those are undone as a
// transfer, so it goes back to a draft rather than claiming it was sent.
export async function transferOfBatch(db: Db, batchId: string) {
	const [t] = await db
		.select({ id: transfers.id })
		.from(transfers)
		.where(eq(transfers.batchId, batchId));
	return t?.id ?? null;
}
