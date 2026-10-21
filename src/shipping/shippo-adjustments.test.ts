import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { saveCostReport } from "#/orders/charges";
import {
	groupBoxes,
	groupPostage,
	postageBoxes,
	postageLines,
} from "#/orders/postage-adjustments";
import { type ProfitFixture, profitFixture } from "#/orders/profit.fixtures";
import { addDispatch } from "#/test/db";
import { readRebills, saveShippoRebills } from "./shippo-adjustments";

let db: Db;
let order: ProfitFixture["order"];
let profit: ProfitFixture["profit"];

beforeEach(async () => {
	({ db, order, profit } = await profitFixture());
});

const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
const end = new Date(Date.now() + 60 * 1000);

// As Shippo's invoice report reads, with the columns asked for.
const HEADER =
	"invoice_item_object_id,invoice_item_type,invoice_item_description,invoice_item_amount,invoice_item_created_at,transaction_object_id";

test("reads re-bills from Shippo's invoice report, and nothing else", () => {
	const csv = [
		HEADER,
		'a1,LABEL_PAYMENT,"",7.61,2026-10-15T17:43:45.645Z,tx-1',
		'a2,LABEL_PAYMENT_ADJUSTMENT,"Weight adjustment: 1 lb, billed 3 lb",4.25,2026-11-20T10:00:00.000Z,tx-1',
		"a3,LABEL_SURCHARGE,,1.10,2026-11-21T10:00:00.000Z,tx-2",
		"a4,LABEL_REFUND_ADJUSTMENT,Credit,-2.00,2026-11-22T10:00:00.000Z,tx-2",
		"a5,TRACK_FEE,Track service fee; $0.02/unit,0.02,2026-09-03T09:03:22.887Z,",
		'a6,LABEL_REFUND,"",-7.57,2026-10-20T04:53:35.384Z,tx-3',
	].join("\n");
	expect(readRebills(csv)).toEqual([
		{
			externalId: "a2",
			type: "LABEL_PAYMENT_ADJUSTMENT",
			description: "Weight adjustment: 1 lb, billed 3 lb",
			amount: 4.25,
			postedAt: new Date("2026-11-20T10:00:00.000Z"),
			transactionId: "tx-1",
		},
		{
			externalId: "a3",
			type: "LABEL_SURCHARGE",
			// No wording of its own: its type says what it is.
			description: "LABEL_SURCHARGE",
			amount: 1.1,
			postedAt: new Date("2026-11-21T10:00:00.000Z"),
			transactionId: "tx-2",
		},
		{
			externalId: "a4",
			type: "LABEL_REFUND_ADJUSTMENT",
			description: "Credit",
			amount: -2,
			postedAt: new Date("2026-11-22T10:00:00.000Z"),
			transactionId: "tx-2",
		},
	]);
});

test("saves re-bills on katasync's labels, shared across the label's orders, again without doubling", async () => {
	const small = await order("#1", [
		{ unitPrice: 10, quantity: 1, unitCost: 2 },
	]);
	const big = await order("#2", [{ unitPrice: 30, quantity: 1, unitCost: 6 }]);
	const [box] = (
		await addDispatch(db, {
			orderIds: [small.id, big.id],
			boxes: [{ cost: 8, externalId: "tx-1" }],
		})
	).boxIds;
	for (const id of [small.id, big.id])
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [],
		});
	const rebills = [
		{
			externalId: "a2",
			type: "LABEL_PAYMENT_ADJUSTMENT",
			description: "Weight",
			amount: 4,
			postedAt: new Date(),
			transactionId: "tx-1",
		},
		// A label bought in Shippo but not through katasync.
		{
			externalId: "a9",
			type: "LABEL_SURCHARGE",
			description: "Fuel",
			amount: 1,
			postedAt: new Date(),
			transactionId: "tx-elsewhere",
		},
	];
	expect(await saveShippoRebills(db, rebills)).toEqual({
		rebills: 2,
		saved: 1,
		elsewhere: 1,
	});
	await saveShippoRebills(db, rebills);
	const saved = await db.select().from(schema.shipmentAdjustments);
	expect(saved.map((s) => [s.shipmentId, s.amount])).toEqual([[box, 4]]);

	// Shared by sales like the label: 1 of 4 and 3 of 4.
	expect(await profit(small.id)).toMatchObject({
		labels: 2,
		postageAdjustments: 1,
		profit: 5,
	});
	expect(await profit(big.id)).toMatchObject({
		labels: 6,
		postageAdjustments: 3,
		profit: 15,
	});

	const lines = groupPostage(await postageLines(db, start, end));
	expect(lines).toMatchObject({ orders: 2, amount: 4 });
	const boxes = groupBoxes(await postageBoxes(db, start, end));
	expect(
		boxes.map((b) => [b.key, b.labels, b.rebilled.length, b.amount, b.cost]),
	).toEqual([["size:300x200x100", 1, 1, 4, 8]]);
	expect(boxes[0].rebilled[0]).toMatchObject({
		weightGrams: 600,
		soldOn: "shopify",
	});
});
