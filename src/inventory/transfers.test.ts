import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { postMovements, transferStock, undoBatch } from "./ledger";
import {
	fillFromSuggestions,
	refillSuggestions,
	setShelfTarget,
} from "./refill";
import { receiveTransfer, undoTransferReceipt } from "./transfer-deliveries";
import {
	createTransfer,
	moveNow,
	sendTransfer,
	setTransferLines,
	transferOfBatch,
	unsendTransfer,
	updateTransfer,
} from "./transfers";

let db: Db;
let warehouse: number;
let retail: number;
let fba: number;

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

async function stock(productId: number, locationId: number, qty: number) {
	await postMovements(db, {
		lines: [{ productId, locationId, delta: qty, reason: "opening_balance" }],
	});
}

async function statusOf(id: number) {
	const [t] = await db
		.select()
		.from(schema.transfers)
		.where(eq(schema.transfers.id, id));
	return t?.status ?? null;
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }, { id: retail }, { id: fba }] = await db
		.insert(schema.locations)
		.values([
			{ name: "Warehouse", kind: "owned" },
			{ name: "Retail", kind: "retail" },
			{ name: "Amazon FBA", kind: "fba" },
		])
		.returning();
});

describe("transferStock", () => {
	test("moves every line in one batch that undo moves back", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		await stock(wrench, warehouse, 10);
		await stock(knife, warehouse, 5);

		const { batchId } = await transferStock(db, {
			fromLocationId: warehouse,
			toLocationId: retail,
			lines: [
				{ productId: wrench, quantity: 4 },
				{ productId: knife, quantity: 2 },
			],
		});
		expect(await onHand(wrench, retail)).toBe(4);
		expect(await onHand(knife, warehouse)).toBe(3);

		await undoBatch(db, batchId);
		expect(await onHand(wrench, warehouse)).toBe(10);
		expect(await onHand(knife, retail)).toBe(0);
	});

	test("refuses when any line is short, naming each, and changes nothing", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		await stock(wrench, warehouse, 3);
		await stock(knife, warehouse, 5);

		await expect(
			transferStock(db, {
				fromLocationId: warehouse,
				toLocationId: retail,
				lines: [
					{ productId: wrench, quantity: 4 },
					{ productId: knife, quantity: 1 },
				],
			}),
		).rejects.toThrow("Warehouse has 3 of WRENCH, not 4");
		expect(await onHand(wrench, warehouse)).toBe(3);
		expect(await onHand(knife, warehouse)).toBe(5);
	});

	test("only between our own locations", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 3);
		const move = (toLocationId: number) =>
			transferStock(db, {
				fromLocationId: warehouse,
				toLocationId,
				lines: [{ productId: wrench, quantity: 1 }],
			});
		await expect(
			transferStock(db, {
				fromLocationId: fba,
				toLocationId: warehouse,
				lines: [{ productId: wrench, quantity: 1 }],
			}),
		).rejects.toThrow("or from one to Amazon FBA");
		await expect(move(warehouse)).rejects.toThrow("two different locations");
	});

	test("to Amazon FBA only leaves: FBA holds what Amazon reports", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);
		await stock(wrench, fba, 2);

		const { batchId } = await transferStock(db, {
			fromLocationId: warehouse,
			toLocationId: fba,
			lines: [{ productId: wrench, quantity: 4 }],
		});
		expect(await onHand(wrench, warehouse)).toBe(6);
		expect(await onHand(wrench, fba)).toBe(2);

		await undoBatch(db, batchId);
		expect(await onHand(wrench, warehouse)).toBe(10);
		expect(await onHand(wrench, fba)).toBe(2);
	});
});

describe("transfers to Amazon FBA", () => {
	test("send at once with nothing to receive, and undo back to a draft", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);
		const id = await createTransfer(db, {
			fromLocationId: warehouse,
			toLocationId: fba,
		});
		await setTransferLines(db, id, [{ productId: wrench, quantity: 3 }]);

		await sendTransfer(db, id);
		expect(await statusOf(id)).toBe("sent");
		expect(await onHand(wrench, warehouse)).toBe(7);
		expect(await onHand(wrench, fba)).toBe(0);
		await expect(
			receiveTransfer(db, { transferId: id, receiptKey: "k" }),
		).rejects.toThrow("arrived when it was sent");

		await unsendTransfer(db, id);
		expect(await statusOf(id)).toBe("draft");
		expect(await onHand(wrench, warehouse)).toBe(10);
	});

	test("a draft can be pointed at FBA, but FBA is never a source", async () => {
		const id = await createTransfer(db, {
			fromLocationId: warehouse,
			toLocationId: retail,
		});
		await updateTransfer(db, id, { toLocationId: fba });
		const [t] = await db
			.select()
			.from(schema.transfers)
			.where(eq(schema.transfers.id, id));
		expect(t.toLocationId).toBe(fba);
		await expect(updateTransfer(db, id, { swap: true })).rejects.toThrow(
			"Amazon's to send",
		);
		await expect(
			createTransfer(db, { fromLocationId: fba, toLocationId: warehouse }),
		).rejects.toThrow("Amazon's to send");
		await expect(
			updateTransfer(db, id, { toLocationId: warehouse }),
		).rejects.toThrow("two different locations");
	});

	test("move now sends one product straight off the shelf", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, retail, 5);
		await moveNow(db, {
			productId: wrench,
			fromLocationId: retail,
			toLocationId: fba,
			quantity: 2,
		});
		expect(await onHand(wrench, retail)).toBe(3);
		expect(await onHand(wrench, fba)).toBe(0);
	});
});

describe("transfers", () => {
	test("a draft sends all at once, and undoing makes it a draft again", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);
		const id = await createTransfer(db, {
			fromLocationId: warehouse,
			toLocationId: retail,
		});
		await setTransferLines(db, id, [{ productId: wrench, quantity: 3 }]);

		const { batchId } = await sendTransfer(db, id);
		expect(await statusOf(id)).toBe("sent");
		expect(await onHand(wrench, retail)).toBe(0);
		expect(await transferOfBatch(db, batchId)).toBe(id);
		await expect(
			setTransferLines(db, id, [{ productId: wrench, quantity: 1 }]),
		).rejects.toThrow("Undo the send to change it");
		const { receiptId } = await receiveTransfer(db, {
			transferId: id,
			receiptKey: "all",
		});
		expect(await onHand(wrench, retail)).toBe(3);
		await expect(unsendTransfer(db, id)).rejects.toThrow(
			"undo those receipts first",
		);
		await undoTransferReceipt(db, { transferId: id, receiptId });

		await unsendTransfer(db, id);
		expect(await statusOf(id)).toBe("draft");
		expect(await onHand(wrench, retail)).toBe(0);
		expect(await onHand(wrench, warehouse)).toBe(10);
		await sendTransfer(db, id);
		await receiveTransfer(db, { transferId: id, receiptKey: "again" });
		expect(await onHand(wrench, retail)).toBe(3);
	});

	test("a draft with nothing on it can't be sent", async () => {
		const id = await createTransfer(db, {
			fromLocationId: warehouse,
			toLocationId: retail,
		});
		await expect(sendTransfer(db, id)).rejects.toThrow("Add what's moving");
	});

	test("lines: 0 takes one off, tool sets are refused, swap flips the route", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await stock(wrench, retail, 2);
		const id = await createTransfer(db, {
			fromLocationId: warehouse,
			toLocationId: retail,
		});
		await setTransferLines(db, id, [{ productId: wrench, quantity: 2 }]);
		await expect(
			setTransferLines(db, id, [{ productId: set, quantity: 1 }]),
		).rejects.toThrow("Tool sets move as their parts: SET");

		await updateTransfer(db, id, { swap: true });
		await sendTransfer(db, id);
		await receiveTransfer(db, { transferId: id, receiptKey: "all" });
		expect(await onHand(wrench, warehouse)).toBe(2);
		expect(await onHand(wrench, retail)).toBe(0);

		const next = await createTransfer(db, {
			fromLocationId: warehouse,
			toLocationId: retail,
		});
		await setTransferLines(db, next, [{ productId: wrench, quantity: 1 }]);
		await setTransferLines(db, next, [{ productId: wrench, quantity: 0 }]);
		await expect(sendTransfer(db, next)).rejects.toThrow("Add what's moving");
	});

	test("a quick move is a sent transfer, and undoing it leaves nothing", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 5);
		const { transferId } = await moveNow(db, {
			productId: wrench,
			fromLocationId: warehouse,
			toLocationId: retail,
			quantity: 2,
		});
		expect(await statusOf(transferId)).toBe("sent");

		await unsendTransfer(db, transferId, { discard: true });
		expect(await statusOf(transferId)).toBeNull();
		expect(await onHand(wrench, warehouse)).toBe(5);
	});
});

describe("refills", () => {
	test("top the store up to its targets, as far as the warehouse has it", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		const blade = await createProduct(db, "BLADE", "simple");
		await stock(wrench, warehouse, 10);
		await stock(wrench, retail, 1);
		await stock(knife, warehouse, 2);
		await stock(blade, retail, 6);
		await setShelfTarget(db, {
			productId: wrench,
			locationId: retail,
			target: 4,
		});
		await setShelfTarget(db, {
			productId: knife,
			locationId: retail,
			target: 5,
		});
		await setShelfTarget(db, {
			productId: blade,
			locationId: retail,
			target: 3,
		});

		const rows = await refillSuggestions(db, {
			fromLocationId: warehouse,
			toLocationId: retail,
		});
		expect(rows.map((r) => [r.sku, r.suggested])).toEqual([
			["KNIFE", 2],
			["WRENCH", 3],
		]);

		const id = await createTransfer(db, {
			fromLocationId: warehouse,
			toLocationId: retail,
		});
		expect(await fillFromSuggestions(db, id)).toEqual({ filled: 2, none: [] });
		await sendTransfer(db, id);
		expect(
			await refillSuggestions(db, {
				fromLocationId: warehouse,
				toLocationId: retail,
			}),
		).toEqual([
			expect.objectContaining({ sku: "KNIFE", inTransit: 2, suggested: 0 }),
		]);
		await receiveTransfer(db, { transferId: id, receiptKey: "all" });
		expect(await onHand(wrench, retail)).toBe(4);
		expect(await onHand(knife, retail)).toBe(2);
		expect(
			await refillSuggestions(db, {
				fromLocationId: warehouse,
				toLocationId: retail,
			}),
		).toEqual([expect.objectContaining({ sku: "KNIFE", suggested: 0 })]);
	});

	test("a target of nothing stops refilling, and tool sets get none", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await setShelfTarget(db, {
			productId: wrench,
			locationId: retail,
			target: 4,
		});
		await setShelfTarget(db, {
			productId: wrench,
			locationId: retail,
			target: null,
		});
		expect(
			await refillSuggestions(db, {
				fromLocationId: warehouse,
				toLocationId: retail,
			}),
		).toEqual([]);
		await expect(
			setShelfTarget(db, { productId: set, locationId: retail, target: 2 }),
		).rejects.toThrow("tool set");
	});
});
