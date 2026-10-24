import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { saveCostReport } from "#/orders/charges";
import { type ProfitFixture, profitFixture } from "#/orders/profit.fixtures";
import { saveShippoRebills } from "#/shipping/shippo-adjustments";
import { addDispatch } from "#/test/db";

let db: Db;
let amazon: number;
let order: ProfitFixture["order"];

beforeEach(async () => {
	({ db, amazon, order } = await profitFixture());
});

const alerts = () => db.select().from(schema.marketEmails);

async function amazonOrder(name: string) {
	const { id } = await order(
		name,
		[{ unitPrice: 99, quantity: 1, unitCost: 40 }],
		{
			storeId: amazon,
			externalId: name,
			marketplaceOrderId: `amazon:${name}`,
		},
	);
	return id;
}

const report = (orderId: number, rebill: number) =>
	saveCostReport(db, {
		orderId,
		billedBy: "amazon",
		settled: false,
		charges: [
			{ kind: "label", description: "PostageBilling_Postage", amount: 32.85 },
			{
				kind: "postage_adjustment",
				description: "PostageBilling_PostageAdjustment",
				amount: rebill,
			},
		],
	});

test("an Amazon re-bill over $10 raises one critical inbox item naming the order", async () => {
	const id = await amazonOrder("113-2885652-5246638");
	await report(id, 10);
	expect(await alerts()).toEqual([]);

	await report(id, 319.75);
	// Read again, or re-billed again, it raises nothing new.
	await report(id, 319.75);
	await report(id, 330);
	const [alert, ...rest] = await alerts();
	expect(rest).toEqual([]);
	expect(alert).toMatchObject({
		market: "amazon",
		folder: "orders",
		important: true,
		critical: true,
		doneAt: null,
		readAt: null,
		subject: "Postage re-billed $319.75: 113-2885652-5246638",
	});
	expect(alert.body).toContain("113-2885652-5246638");
	expect(alert.bodyHtml).toContain('href="/profit/postage"');
	expect(alert.bodyHtml).toContain(`href="/orders/${id}"`);
	expect(alert.bodyHtml).toContain(
		"sellercentral.amazon.com/orders-v3/order/113-2885652-5246638",
	);
});

test("an order already re-billed over $10 raises nothing when its report is read again", async () => {
	const id = await amazonOrder("111-0905004-3588217");
	// As if saved before alerts existed.
	await report(id, 58.48);
	await db.delete(schema.marketEmails);
	await report(id, 58.48);
	expect(await alerts()).toEqual([]);
});

test("a Shippo re-bill over $10 raises one item for its label", async () => {
	const shop = await order("#6001", [
		{ unitPrice: 50, quantity: 1, unitCost: 10 },
	]);
	await addDispatch(db, {
		orderIds: [shop.id],
		boxes: [{ cost: 8, externalId: "tx-1" }],
	});
	const rebill = (externalId: string, amount: number) => ({
		externalId,
		type: "LABEL_PAYMENT_ADJUSTMENT",
		description: "Weight",
		amount,
		postedAt: new Date(),
		transactionId: "tx-1",
	});
	await saveShippoRebills(db, [rebill("a1", 6)]);
	expect(await alerts()).toEqual([]);
	await saveShippoRebills(db, [rebill("a1", 6), rebill("a2", 6)]);
	await saveShippoRebills(db, [rebill("a1", 6), rebill("a2", 6)]);
	const all = await alerts();
	expect(all).toHaveLength(1);
	expect(all[0]).toMatchObject({
		critical: true,
		subject: "Postage re-billed $12.00: #6001",
	});
});
