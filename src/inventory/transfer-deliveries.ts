import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	transferDispatches,
	transferDispatchLines,
	transferReceiptLines,
	transferReceipts,
} from "#/db/quantity-schema";
import { movements, transfers } from "#/db/schema";
import { undoBatch } from "#/inventory/ledger";
import { postTransitLeg } from "#/inventory/ledger/transfer-deliveries";
import { transitLocation } from "./locations";

export class DeliveryError extends Error {
	name = "DeliveryError";
}

export type DeliveryLine = {
	productId: number;
	sent: number;
	received: number;
	inTransit: number;
};

export type Receipt = {
	id: number;
	receiptKey: string;
	createdAt: Date;
	undone: boolean;
	lines: { productId: number; quantity: number }[];
};

export type Delivery =
	| { kind: "draft" }
	| { kind: "completed" }
	| {
			kind: "in_transit" | "received";
			dispatchId: number;
			transitLocationId: number;
			lines: DeliveryLine[];
			receipts: Receipt[];
	  };

const receiptUndone = sql<boolean>`exists (select 1 from "movements" u where u.reference = 'undo:' || "transfer_receipts"."batch_id"::text)`;

export async function deliveriesOf(
	db: Db,
	transferIds: number[],
): Promise<Map<number, Delivery>> {
	const result = new Map<number, Delivery>();
	if (transferIds.length === 0) return result;
	const rows = await db
		.select({
			id: transfers.id,
			status: transfers.status,
			dispatchId: transferDispatches.id,
			transitLocationId: transferDispatches.transitLocationId,
		})
		.from(transfers)
		.leftJoin(
			transferDispatches,
			and(
				eq(transferDispatches.transferId, transfers.id),
				eq(transferDispatches.batchId, transfers.batchId),
			),
		)
		.where(inArray(transfers.id, transferIds));
	const dispatchIds = rows.flatMap((r) => (r.dispatchId ? [r.dispatchId] : []));
	const [sent, receipts, received] =
		dispatchIds.length === 0
			? [[], [], []]
			: await Promise.all([
					db
						.select()
						.from(transferDispatchLines)
						.where(inArray(transferDispatchLines.dispatchId, dispatchIds))
						.orderBy(transferDispatchLines.productId),
					db
						.select({
							id: transferReceipts.id,
							dispatchId: transferReceipts.dispatchId,
							receiptKey: transferReceipts.receiptKey,
							createdAt: transferReceipts.createdAt,
							undone: receiptUndone,
						})
						.from(transferReceipts)
						.where(inArray(transferReceipts.dispatchId, dispatchIds))
						.orderBy(desc(transferReceipts.createdAt)),
					db
						.select({
							receiptId: transferReceiptLines.receiptId,
							productId: transferReceiptLines.productId,
							quantity: transferReceiptLines.quantity,
						})
						.from(transferReceiptLines)
						.innerJoin(
							transferReceipts,
							eq(transferReceipts.id, transferReceiptLines.receiptId),
						)
						.where(inArray(transferReceipts.dispatchId, dispatchIds)),
				]);
	for (const row of rows) {
		if (row.status === "draft") {
			result.set(row.id, { kind: "draft" });
			continue;
		}
		if (!row.dispatchId || row.transitLocationId === null) {
			result.set(row.id, { kind: "completed" });
			continue;
		}
		const mine = receipts
			.filter((r) => r.dispatchId === row.dispatchId)
			.map((r) => ({
				id: r.id,
				receiptKey: r.receiptKey,
				createdAt: r.createdAt,
				undone: r.undone,
				lines: received
					.filter((l) => l.receiptId === r.id)
					.map((l) => ({ productId: l.productId, quantity: l.quantity })),
			}));
		const lines = sent
			.filter((l) => l.dispatchId === row.dispatchId)
			.map((l) => {
				const got = mine
					.filter((r) => !r.undone)
					.flatMap((r) => r.lines)
					.filter((x) => x.productId === l.productId)
					.reduce((n, x) => n + x.quantity, 0);
				return {
					productId: l.productId,
					sent: l.quantity,
					received: got,
					inTransit: l.quantity - got,
				};
			});
		result.set(row.id, {
			kind: lines.some((l) => l.inTransit > 0) ? "in_transit" : "received",
			dispatchId: row.dispatchId,
			transitLocationId: row.transitLocationId,
			lines,
			receipts: mine,
		});
	}
	return result;
}

export async function deliveryOf(db: Db, transferId: number) {
	const found = (await deliveriesOf(db, [transferId])).get(transferId);
	if (!found) throw new DeliveryError(`No transfer T${transferId}`);
	return found;
}

async function lockSent(tx: Db, transferId: number) {
	const [t] = await tx
		.select()
		.from(transfers)
		.where(eq(transfers.id, transferId))
		.for("update");
	if (!t) throw new DeliveryError(`No transfer T${transferId}`);
	const delivery = await deliveryOf(tx, transferId);
	return { transfer: t, delivery };
}

export async function dispatchTransfer(
	tx: Db,
	transfer: { id: number; fromLocationId: number; note: string | null },
	lines: { productId: number; quantity: number }[],
) {
	const transitLocationId = await transitLocation(tx);
	const { batchId } = await postTransitLeg(tx, {
		leg: "dispatch",
		fromLocationId: transfer.fromLocationId,
		toLocationId: transitLocationId,
		lines,
		reference: `transfer:${transfer.id}`,
		note: transfer.note ?? undefined,
	});
	await tx
		.update(transfers)
		.set({ status: "sent", batchId, sentAt: new Date() })
		.where(eq(transfers.id, transfer.id));
	const [dispatch] = await tx
		.insert(transferDispatches)
		.values({ transferId: transfer.id, batchId, transitLocationId })
		.returning({ id: transferDispatches.id });
	await tx
		.insert(transferDispatchLines)
		.values(lines.map((l) => ({ ...l, dispatchId: dispatch.id })));
	return { batchId, dispatchId: dispatch.id };
}

export type ReceiveResult = {
	receiptId: number;
	batchId: string;
	repeated: boolean;
	delivery: Delivery;
};

const sameLines = (
	a: { productId: number; quantity: number }[],
	b: { productId: number; quantity: number }[],
) =>
	a.length === b.length &&
	a.every((x) =>
		b.some((y) => y.productId === x.productId && y.quantity === x.quantity),
	);

export async function receiveTransfer(
	db: Db,
	input: {
		transferId: number;
		receiptKey: string;
		lines?: { productId: number; quantity: number }[];
	},
): Promise<ReceiveResult> {
	const key = input.receiptKey.trim();
	if (key.length === 0) throw new DeliveryError("A receipt needs a key");
	for (const l of input.lines ?? [])
		if (!Number.isInteger(l.quantity) || l.quantity < 0)
			throw new DeliveryError("Received counts are whole numbers from 0");
	if (input.lines && new Set(input.lines.map((l) => l.productId)).size !== input.lines.length)
		throw new DeliveryError("Count each product once per receipt");
	return db.transaction(async (tx) => {
		const { transfer, delivery } = await lockSent(tx, input.transferId);
		if (delivery.kind === "draft" || delivery.kind === "completed")
			throw new DeliveryError(
				delivery.kind === "draft"
					? `T${transfer.id} hasn't been sent`
					: `T${transfer.id} arrived when it was sent`,
			);
		const lines = (
			input.lines ??
			delivery.lines.map((l) => ({ productId: l.productId, quantity: l.inTransit }))
		).filter((l) => l.quantity > 0);
		const earlier = delivery.receipts.find((r) => r.receiptKey === key);
		if (earlier) {
			if (input.lines && !sameLines(earlier.lines, lines))
				throw new DeliveryError(`Receipt ${key} was recorded with other counts`);
			const [row] = await tx
				.select({ batchId: transferReceipts.batchId })
				.from(transferReceipts)
				.where(eq(transferReceipts.id, earlier.id));
			return { receiptId: earlier.id, batchId: row.batchId, repeated: true, delivery };
		}
		if (lines.length === 0)
			throw new DeliveryError(`Nothing of T${transfer.id} is still in transit`);
		for (const l of lines) {
			const open = delivery.lines.find((d) => d.productId === l.productId);
			if (!open)
				throw new DeliveryError(`Product ${l.productId} isn't on T${transfer.id}`);
			if (l.quantity > open.inTransit)
				throw new DeliveryError(
					`Only ${open.inTransit} of product ${l.productId} is still in transit`,
				);
		}
		const { batchId } = await postTransitLeg(tx, {
			leg: "receive",
			fromLocationId: delivery.transitLocationId,
			toLocationId: transfer.toLocationId,
			lines,
			reference: `transfer:${transfer.id}`,
		});
		const [receipt] = await tx
			.insert(transferReceipts)
			.values({ dispatchId: delivery.dispatchId, receiptKey: key, batchId })
			.returning({ id: transferReceipts.id });
		await tx
			.insert(transferReceiptLines)
			.values(lines.map((l) => ({ ...l, receiptId: receipt.id })));
		return {
			receiptId: receipt.id,
			batchId,
			repeated: false,
			delivery: await deliveryOf(tx, transfer.id),
		};
	});
}

export async function undoTransferReceipt(
	db: Db,
	input: { transferId: number; receiptId: number },
) {
	return db.transaction(async (tx) => {
		const { delivery } = await lockSent(tx, input.transferId);
		if (delivery.kind !== "in_transit" && delivery.kind !== "received")
			throw new DeliveryError("That transfer has no receipts to undo");
		const receipt = delivery.receipts.find((r) => r.id === input.receiptId);
		if (!receipt) throw new DeliveryError("That receipt isn't on this transfer");
		if (receipt.undone) throw new DeliveryError("That receipt was already undone");
		const [row] = await tx
			.select({ batchId: transferReceipts.batchId })
			.from(transferReceipts)
			.where(eq(transferReceipts.id, receipt.id));
		await undoBatch(tx, row.batchId);
		return deliveryOf(tx, input.transferId);
	});
}

export function liveReceipts(delivery: Delivery) {
	return delivery.kind === "in_transit" || delivery.kind === "received"
		? delivery.receipts.filter((r) => !r.undone)
		: [];
}

export async function inTransitTo(
	db: Db,
	toLocationId: number,
	productIds: number[],
): Promise<Map<number, number>> {
	const result = new Map<number, number>();
	if (productIds.length === 0) return result;
	const rows = await db
		.select({
			productId: transferDispatchLines.productId,
			sent: transferDispatchLines.quantity,
			received: sql<number>`coalesce((
				select sum(l.quantity) from ${transferReceiptLines} l
				join ${transferReceipts} r on r.id = l.receipt_id
				where r.dispatch_id = ${transferDispatches.id}
					and l.product_id = ${transferDispatchLines.productId}
					and not exists (select 1 from ${movements} u where u.reference = 'undo:' || r.batch_id::text)
			), 0)::int`,
		})
		.from(transferDispatchLines)
		.innerJoin(
			transferDispatches,
			eq(transferDispatches.id, transferDispatchLines.dispatchId),
		)
		.innerJoin(
			transfers,
			and(
				eq(transfers.id, transferDispatches.transferId),
				eq(transfers.batchId, transferDispatches.batchId),
			),
		)
		.where(
			and(
				eq(transfers.toLocationId, toLocationId),
				inArray(transferDispatchLines.productId, productIds),
			),
		);
	for (const row of rows)
		result.set(
			row.productId,
			(result.get(row.productId) ?? 0) + row.sent - row.received,
		);
	return result;
}
