import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { addDispatch } from "#/test/db";
import { saveCostReport } from "./charges";
import { type ProfitFixture, profitFixture } from "./profit.fixtures";

let db: Db;
let amazon: number;
let order: ProfitFixture["order"];
let profit: ProfitFixture["profit"];

beforeEach(async () => {
	({ db, amazon, order, profit } = await profitFixture());
});

describe("order_profit", () => {
	test("a Shopify order with its fees and Shopify Shipping label", async () => {
		const { id } = await order(
			"#1",
			[{ unitPrice: 20, quantity: 2, unitCost: 8 }],
			{ shippingCharged: 6.5 },
		);
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [
				{ kind: "fee", description: "Processing fee", amount: 1.46 },
				{ kind: "label", description: "Shopify Shipping labels", amount: 5.72 },
			],
		});
		expect(await profit(id)).toMatchObject({
			soldOn: "shopify",
			revenue: 40,
			shippingCharged: 6.5,
			cost: 16,
			costKnown: true,
			fees: 1.46,
			feesStatus: "reported",
			labels: 5.72,
			labelsStatus: "known",
			// 40 + 6.50 - 16 - 1.46 - 5.72
			profit: 23.32,
			complete: true,
		});
	});

	test("until the marketplace reports, fees are estimated and the order incomplete", async () => {
		const { id } = await order(
			"#2",
			[{ unitPrice: 100, quantity: 1, unitCost: 40 }],
			{ storeId: amazon, marketplaceOrderId: "amazon:1" },
		);
		expect(await profit(id)).toMatchObject({
			fees: 15,
			feesStatus: "estimated",
			// Amazon may yet bill a label it sold.
			labelsStatus: "awaiting",
			complete: false,
		});
	});

	test("a relayed TikTok order is TikTok's to bill, not Shopify's", async () => {
		const { id } = await order(
			"#3",
			[{ unitPrice: 50, quantity: 1, unitCost: 20 }],
			{ marketplaceOrderId: "tiktok:577" },
		);
		// Shopify reports it charged nothing; TikTok hasn't settled yet.
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [],
		});
		expect(await profit(id)).toMatchObject({
			soldOn: "tiktok",
			fees: 3,
			feesStatus: "estimated",
		});
		await saveCostReport(db, {
			orderId: id,
			billedBy: "tiktok",
			settled: true,
			charges: [{ kind: "fee", description: "Referral fee", amount: 3.2 }],
		});
		expect(await profit(id)).toMatchObject({ fees: 3.2, feesStatus: "final" });
	});

	test("a katasync label shared by two orders is split by their revenue", async () => {
		const small = await order("#4", [
			{ unitPrice: 10, quantity: 1, unitCost: 4 },
		]);
		const big = await order("#5", [
			{ unitPrice: 30, quantity: 1, unitCost: 12 },
		]);
		await addDispatch(db, {
			orderIds: [small.id, big.id],
			boxes: [{ cost: 8 }],
		});
		expect((await profit(small.id)).labels).toBe(2);
		expect((await profit(big.id)).labels).toBe(6);
		expect((await profit(big.id)).labelsStatus).toBe("known");
	});

	test("voided and test labels cost nothing", async () => {
		const { id } = await order("#6", [
			{ unitPrice: 10, quantity: 1, unitCost: 4 },
		]);
		await addDispatch(db, {
			orderIds: [id],
			boxes: [
				{ cost: 8, voidedAt: new Date() },
				{ cost: 9, test: true },
			],
		});
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [],
		});
		expect((await profit(id)).labels).toBe(0);
	});

	test("a draft order with no label and no shipping charged was picked up", async () => {
		const { id } = await order(
			"#6b",
			[{ unitPrice: 55, quantity: 1, unitCost: 0 }],
			{
				salesChannel: "Draft Orders",
				sourceUpdatedAt: new Date(Date.now() - 60_000),
			},
		);
		// Not asked since: Shopify may still show a label.
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [],
			fetchedAt: new Date(Date.now() - 120_000),
		});
		expect((await profit(id)).labelsStatus).toBe("awaiting");
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [{ kind: "fee", description: "Processing fee", amount: 1.9 }],
		});
		expect(await profit(id)).toMatchObject({
			labels: 0,
			labelsStatus: "not_needed",
			complete: true,
			shipped: true,
		});
	});

	test("an old counter sale with no label needs none, however stale its report", async () => {
		const { id } = await order(
			"#6c",
			[{ unitPrice: 55, quantity: 1, unitCost: 0 }],
			{
				salesChannel: "Point of Sale",
				placedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
			},
		);
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [],
			fetchedAt: new Date(Date.now() - 120_000),
		});
		expect((await profit(id)).labelsStatus).toBe("not_needed");
	});

	test("an online order, or one that charged shipping, with no label is missing one", async () => {
		const online = await order(
			"#6e",
			[{ unitPrice: 20, quantity: 1, unitCost: 5 }],
			{ salesChannel: "Online Store" },
		);
		const shipped = await order(
			"#6f",
			[{ unitPrice: 20, quantity: 1, unitCost: 5 }],
			{ salesChannel: "Draft Orders", shippingCharged: 9.66 },
		);
		for (const { id } of [online, shipped]) {
			await saveCostReport(db, {
				orderId: id,
				billedBy: "shopify",
				settled: false,
				charges: [],
			});
			expect((await profit(id)).labelsStatus).toBe("missing");
		}
	});

	test("a shipped Amazon order with no label from anyone is missing one", async () => {
		const { id } = await order(
			"#6d",
			[{ unitPrice: 20, quantity: 1, unitCost: 5 }],
			{ storeId: amazon, marketplaceOrderId: "amazon:6d" },
		);
		await saveCostReport(db, {
			orderId: id,
			billedBy: "amazon",
			settled: false,
			charges: [],
		});
		expect((await profit(id)).labelsStatus).toBe("missing");
	});

	test("a TikTok label bought in katasync stands in until TikTok bills it", async () => {
		const { id } = await order(
			"#7",
			[{ unitPrice: 25, quantity: 1, unitCost: 10 }],
			{ marketplaceOrderId: "tiktok:578" },
		);
		await addDispatch(db, {
			orderIds: [id],
			boxes: [{ provider: "tiktok", cost: 6 }],
		});
		expect(await profit(id)).toMatchObject({
			labels: 6,
			labelsStatus: "stand_in",
			complete: false,
		});
		await saveCostReport(db, {
			orderId: id,
			billedBy: "tiktok",
			settled: true,
			charges: [
				{ kind: "fee", description: "Referral fee", amount: 1.5 },
				{ kind: "label", description: "Actual shipping fee", amount: 5.72 },
			],
		});
		// TikTok's own bill replaces the stand-in rather than adding to it.
		expect(await profit(id)).toMatchObject({
			labels: 5.72,
			labelsStatus: "known",
			complete: true,
		});
	});

	test("a cancelled order sharing a box leaves its share to the others", async () => {
		const kept = await order("#13", [
			{ unitPrice: 10, quantity: 1, unitCost: 4 },
		]);
		const gone = await order(
			"#14",
			[{ unitPrice: 30, quantity: 1, unitCost: 12 }],
			{
				cancelledAt: new Date(),
			},
		);
		await addDispatch(db, {
			orderIds: [kept.id, gone.id],
			boxes: [{ cost: 8 }],
		});
		expect((await profit(kept.id)).labels).toBe(8);
	});

	test("Shopify's timeline labels stand in until its labels report has them", async () => {
		const { id } = await order("#15", [
			{ unitPrice: 10, quantity: 1, unitCost: 4 },
		]);
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			labelsPending: true,
			charges: [{ kind: "label", description: "Labels", amount: 5.72 }],
		});
		expect(await profit(id)).toMatchObject({
			labels: 5.72,
			labelsStatus: "stand_in",
			complete: false,
		});
	});
});
