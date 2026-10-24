import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { postMovements, recordCount, transferStock, undoBatch } from "./ledger";
import { setPosLocation, TRANSIT_LOCATION, transitLocation } from "./locations";
import { onlineStock } from "./online-stock";
import { stockPositions } from "./stock-position";
import {
	deliveryOf,
	receiveTransfer,
	undoTransferReceipt,
} from "./transfer-deliveries";
import {
	createTransfer,
	moveNow,
	sendTransfer,
	setTransferLines,
	unsendTransfer,
} from "./transfers";

let db: Db;
let warehouse: number;
let retail: number;

async function onHand(productId: number, locationId: number) {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(
			and(
				eq(schema.stockLevels.productId, productId),
				eq(schema.stockLevels.locationId, locationId),
			),
		);
	return row?.onHand ?? 0;
}

async function sentDraft(productId: number, quantity: number) {
	const id = await createTransfer(db, {
		fromLocationId: warehouse,
		toLocationId: retail,
	});
	await setTransferLines(db, id, [{ productId, quantity }]);
	await sendTransfer(db, id);
	return id;
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }, { id: retail }] = await db
		.insert(schema.locations)
		.values([
			{ name: "Warehouse", kind: "owned" },
			{ name: "Retail", kind: "retail" },
		])
		.returning();
});

describe("transfers through transit", () => {
	test("in-transit units cannot be replaced by a shelf count", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const transit = await transitLocation(db);
		await expect(
			recordCount(db, {
				productId: wrench,
				locationId: transit,
				counted: 12,
				note: "not a shelf",
			}),
		).rejects.toThrow(/in-transit/);
		expect(await onHand(wrench, transit)).toBe(0);
	});

	test("send 10, receive 4: the store has 4 and 6 are still on the way", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await postMovements(db, {
			lines: [
				{
					productId: wrench,
					locationId: warehouse,
					delta: 10,
					reason: "receipt",
				},
			],
		});
		const id = await sentDraft(wrench, 10);
		const transit = await transitLocation(db);
		expect(await onHand(wrench, warehouse)).toBe(0);
		expect(await onHand(wrench, transit)).toBe(10);

		await receiveTransfer(db, {
			transferId: id,
			receiptKey: "box-1",
			lines: [{ productId: wrench, quantity: 4 }],
		});
		expect(await onHand(wrench, retail)).toBe(4);
		expect(await onHand(wrench, transit)).toBe(6);
		expect(await deliveryOf(db, id)).toMatchObject({
			kind: "in_transit",
			lines: [{ productId: wrench, sent: 10, received: 4, inTransit: 6 }],
		});
		const total =
			(await onHand(wrench, warehouse)) +
			(await onHand(wrench, transit)) +
			(await onHand(wrench, retail));
		expect(total).toBe(10);
		expect((await stockPositions(db, [wrench])).get(wrench)).toMatchObject({
			inTransit: 6,
		});
	});

	test("a repeated receipt changes nothing; receiving more than is on the way is refused", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await postMovements(db, {
			lines: [
				{
					productId: wrench,
					locationId: warehouse,
					delta: 5,
					reason: "receipt",
				},
			],
		});
		const id = await sentDraft(wrench, 5);
		const box = {
			transferId: id,
			receiptKey: "box-1",
			lines: [{ productId: wrench, quantity: 3 }],
		};
		const first = await receiveTransfer(db, box);
		const again = await receiveTransfer(db, box);
		expect(again).toMatchObject({ repeated: true, receiptId: first.receiptId });
		expect(await onHand(wrench, retail)).toBe(3);
		await expect(
			receiveTransfer(db, {
				...box,
				lines: [{ productId: wrench, quantity: 2 }],
			}),
		).rejects.toThrow("other counts");
		await expect(
			receiveTransfer(db, {
				transferId: id,
				receiptKey: "box-2",
				lines: [{ productId: wrench, quantity: 3 }],
			}),
		).rejects.toThrow("Only 2");
		expect(await onHand(wrench, retail)).toBe(3);
	});

	test("undoing a receipt puts it back in transit, and the send undoes once nothing is received", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await postMovements(db, {
			lines: [
				{
					productId: wrench,
					locationId: warehouse,
					delta: 5,
					reason: "receipt",
				},
			],
		});
		const id = await sentDraft(wrench, 5);
		const transit = await transitLocation(db);
		const { receiptId } = await receiveTransfer(db, {
			transferId: id,
			receiptKey: "all",
		});
		expect(await deliveryOf(db, id)).toMatchObject({ kind: "received" });
		await expect(unsendTransfer(db, id, { discard: true })).rejects.toThrow(
			"undo those receipts first",
		);
		await undoTransferReceipt(db, { transferId: id, receiptId });
		await expect(
			undoTransferReceipt(db, { transferId: id, receiptId }),
		).rejects.toThrow("already undone");
		expect(await onHand(wrench, transit)).toBe(5);
		expect(await onHand(wrench, retail)).toBe(0);
		await expect(unsendTransfer(db, id, { discard: true })).rejects.toThrow(
			"went through transit",
		);
		await unsendTransfer(db, id);
		expect(await onHand(wrench, transit)).toBe(0);
		expect(await onHand(wrench, warehouse)).toBe(5);
		expect(await deliveryOf(db, id)).toEqual({ kind: "draft" });
	});

	test("transfers sent before transit, and quick moves, count as arrived", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await postMovements(db, {
			lines: [
				{
					productId: wrench,
					locationId: warehouse,
					delta: 8,
					reason: "receipt",
				},
			],
		});
		const old = await createTransfer(db, {
			fromLocationId: warehouse,
			toLocationId: retail,
		});
		await setTransferLines(db, old, [{ productId: wrench, quantity: 3 }]);
		const { batchId } = await transferStock(db, {
			fromLocationId: warehouse,
			toLocationId: retail,
			lines: [{ productId: wrench, quantity: 3 }],
			reference: `transfer:${old}`,
		});
		await db
			.update(schema.transfers)
			.set({ status: "sent", batchId, sentAt: new Date() })
			.where(eq(schema.transfers.id, old));
		expect(await deliveryOf(db, old)).toEqual({ kind: "completed" });
		await expect(
			receiveTransfer(db, { transferId: old, receiptKey: "late" }),
		).rejects.toThrow("arrived when it was sent");

		const { transferId } = await moveNow(db, {
			productId: wrench,
			fromLocationId: warehouse,
			toLocationId: retail,
			quantity: 2,
		});
		expect(await deliveryOf(db, transferId)).toEqual({ kind: "completed" });
		expect(await onHand(wrench, retail)).toBe(5);
		await unsendTransfer(db, transferId, { discard: true });
		expect(await onHand(wrench, retail)).toBe(3);
		await undoBatch(db, batchId);
		expect(await onHand(wrench, warehouse)).toBe(8);
	});

	test("transit is never a shelf to sell, count, or ring up from", async () => {
		const transit = await transitLocation(db);
		expect(await transitLocation(db)).toBe(transit);
		const [row] = await db
			.select()
			.from(schema.locations)
			.where(eq(schema.locations.id, transit));
		expect(row).toMatchObject({ name: TRANSIT_LOCATION, kind: "transit" });
		await expect(setPosLocation(db, transit)).rejects.toThrow("in transit");
		expect((await onlineStock(db)).locationIds).not.toContain(transit);
		const wrench = await createProduct(db, "WRENCH", "simple");
		await expect(
			transferStock(db, {
				fromLocationId: warehouse,
				toLocationId: transit,
				lines: [{ productId: wrench, quantity: 1 }],
			}),
		).rejects.toThrow("our own locations");
	});
});
