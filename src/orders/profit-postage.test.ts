import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct } from "#/test/db";
import { type ReportedCharge, saveCostReport } from "./charges";
import { groupPostage, postageLines } from "./postage-adjustments";
import { profitTotals } from "./profit";
import { type ProfitFixture, profitFixture } from "./profit.fixtures";

let db: Db;
let amazon: number;
let order: ProfitFixture["order"];

beforeEach(async () => {
	({ db, amazon, order } = await profitFixture());
});

const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
const end = new Date(Date.now() + 60 * 1000);

async function amazonOrder(
	name: string,
	lines: Parameters<ProfitFixture["order"]>[1],
	charges: ReportedCharge[],
) {
	const { id } = await order(name, lines, {
		storeId: amazon,
		externalId: name,
		marketplaceOrderId: `amazon:${name}`,
	});
	await saveCostReport(db, {
		orderId: id,
		billedBy: "amazon",
		settled: false,
		charges,
	});
	return id;
}

const label = (amount: number): ReportedCharge => ({
	kind: "label",
	description: "PostageBilling_Postage",
	amount,
});
const rebill = (amount: number): ReportedCharge => ({
	kind: "postage_adjustment",
	description: "PostageBilling_PostageAdjustment",
	amount,
});

test("groups re-bills by what was in the box and by product, against how often each shipped", async () => {
	const vise = await createProduct(db, "VISE", "simple");
	await db
		.update(schema.products)
		.set({ weightGrams: 900, lengthMm: 300, widthMm: 200, heightMm: 100 })
		.where(eq(schema.products.id, vise));
	const wrenchLine = { unitPrice: 20, quantity: 1, unitCost: 5 };
	// Three wrench-alone boxes, one re-billed.
	const rebilled = await amazonOrder(
		"111-1",
		[wrenchLine],
		[label(8), rebill(4)],
	);
	await amazonOrder("111-2", [wrenchLine], [label(8)]);
	await amazonOrder("111-3", [wrenchLine], [label(8)]);
	// A wrench and a vise together, re-billed.
	const both = await amazonOrder(
		"111-4",
		[wrenchLine, { unitPrice: 60, quantity: 1, unitCost: 20 }],
		[label(10), rebill(20)],
	);
	await db
		.update(schema.orderLines)
		.set({ productId: vise, sku: "VISE" })
		.where(eq(schema.orderLines.externalId, "111-4-1"));
	// A Shopify order: its marketplace never re-bills, so it doesn't count.
	const shopify = await order("#5", [wrenchLine]);
	await saveCostReport(db, {
		orderId: shopify.id,
		billedBy: "shopify",
		settled: false,
		charges: [{ kind: "label", description: "Shopify Shipping", amount: 6 }],
	});

	const g = groupPostage(await postageLines(db, start, end));
	expect(g.orders).toBe(4);
	expect(g.amount).toBe(24);
	expect(g.labels).toBe(18);
	expect(g.rebilled.map((o) => [o.id, o.amount, o.marketplaceId])).toEqual([
		[both, 20, "111-4"],
		[rebilled, 4, "111-1"],
	]);
	expect(
		g.byContents.map((c) => [c.key, c.rebilled.length, c.orders, c.amount]),
	).toEqual([
		["VISE×1|WRENCH×1", 1, 1, 20],
		["WRENCH×1", 1, 3, 4],
	]);
	// The vise's share of its box's re-bill is by sales: 60 of 80.
	expect(
		g.byProduct.map((p) => [
			p.sku,
			p.rebilled.length,
			p.orders,
			p.amount,
			p.weightGrams,
			p.box,
		]),
	).toEqual([
		["VISE", 1, 1, 15, 900, [300, 200, 100]],
		["WRENCH", 2, 4, 9, null, null],
	]);
	expect(g.unmatched).toBe(0);

	const totals = await profitTotals(db, start, end);
	expect(totals).toMatchObject({ postageAdjustments: 24, postageAdjusted: 2 });
});
