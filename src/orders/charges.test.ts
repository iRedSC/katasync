import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { type CostReport, saveCostReport } from "./charges";

let db: Db;
let shopifyOrder: number;
let relayedOrder: number;

beforeEach(async () => {
	db = await createTestDb();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	const order = (externalId: string, marketplaceOrderId: string | null) => ({
		storeId: store.id,
		externalId,
		name: `#${externalId}`,
		marketplaceOrderId,
		placedAt: new Date("2026-10-05T12:00:00Z"),
		fulfillmentStatus: "FULFILLED",
		total: 40,
		sourceUpdatedAt: new Date("2026-10-05T12:00:00Z"),
	});
	[{ id: shopifyOrder }, { id: relayedOrder }] = await db
		.insert(schema.orders)
		.values([order("1001", null), order("1002", "tiktok:577")])
		.returning();
});

function charges(orderId: number) {
	return db
		.select({
			billedBy: schema.orderCharges.billedBy,
			kind: schema.orderCharges.kind,
			description: schema.orderCharges.description,
			amount: schema.orderCharges.amount,
		})
		.from(schema.orderCharges)
		.where(eq(schema.orderCharges.orderId, orderId))
		.orderBy(schema.orderCharges.id);
}

const at = (minute: number) =>
	new Date(`2026-10-06T12:${String(minute).padStart(2, "0")}:00Z`);

const report = (overrides: Partial<CostReport> = {}): CostReport => ({
	orderId: relayedOrder,
	billedBy: "tiktok",
	settled: false,
	fetchedAt: at(0),
	charges: [
		{ kind: "fee", description: "Referral fee", amount: 2.4 },
		{ kind: "label", description: "Shipping fee", amount: 6.1 },
	],
	...overrides,
});

describe("saveCostReport", () => {
	test("keeps a relayed order's charges under the marketplace that billed them", async () => {
		expect(await saveCostReport(db, report())).toBe(true);
		expect(await charges(relayedOrder)).toEqual([
			{
				billedBy: "tiktok",
				kind: "fee",
				description: "Referral fee",
				amount: 2.4,
			},
			{
				billedBy: "tiktok",
				kind: "label",
				description: "Shipping fee",
				amount: 6.1,
			},
		]);
	});

	test("replaces the whole report on refresh", async () => {
		await saveCostReport(db, report());
		await saveCostReport(
			db,
			report({
				fetchedAt: at(5),
				charges: [{ kind: "fee", description: "Referral fee", amount: 2.55 }],
			}),
		);
		expect(await charges(relayedOrder)).toEqual([
			expect.objectContaining({ description: "Referral fee", amount: 2.55 }),
		]);
	});

	test("records that nothing was charged, apart from not having heard", async () => {
		const reports = () =>
			db
				.select()
				.from(schema.orderCostReports)
				.where(eq(schema.orderCostReports.orderId, shopifyOrder));
		expect(await reports()).toEqual([]);
		await saveCostReport(
			db,
			report({
				orderId: shopifyOrder,
				billedBy: "shopify",
				charges: [{ kind: "fee", description: "Shopify Payments", amount: 0 }],
			}),
		);
		expect(await reports()).toHaveLength(1);
		expect(await charges(shopifyOrder)).toEqual([]);
	});

	test("an unsettled report can't replace a settled one", async () => {
		await saveCostReport(db, report({ settled: true }));
		const fallback = report({
			fetchedAt: at(5),
			charges: [{ kind: "fee", description: "Referral fee", amount: 9 }],
		});
		expect(await saveCostReport(db, fallback)).toBe(false);
		expect(await charges(relayedOrder)).toHaveLength(2);
		// A later settled statement (say, after a refund) still replaces it.
		expect(await saveCostReport(db, { ...fallback, settled: true })).toBe(true);
		expect(await charges(relayedOrder)).toHaveLength(1);
	});

	test("an older fetch finishing late doesn't overwrite a newer one", async () => {
		await saveCostReport(db, report({ fetchedAt: at(5) }));
		expect(
			await saveCostReport(db, report({ fetchedAt: at(1), charges: [] })),
		).toBe(false);
		expect(await charges(relayedOrder)).toHaveLength(2);
	});

	test("rounds to cents and keeps credits as negatives", async () => {
		await saveCostReport(
			db,
			report({
				charges: [
					{ kind: "fee", description: " Referral fee ", amount: 2.404 },
					{ kind: "adjustment", description: "Reimbursement", amount: -1.5 },
				],
			}),
		);
		expect(await charges(relayedOrder)).toEqual([
			expect.objectContaining({ description: "Referral fee", amount: 2.4 }),
			expect.objectContaining({ kind: "adjustment", amount: -1.5 }),
		]);
	});

	test("a fallback keeps the authoritative label figures on file, $0 included", async () => {
		const fallback = report({
			fetchedAt: at(1),
			labelsAuthoritative: false,
			labelsPending: true,
			charges: [
				{ kind: "fee", description: "Referral fee", amount: 3 },
				{ kind: "label", description: "Shipping fee", amount: 6.1 },
			],
		});
		await saveCostReport(
			db,
			report({
				charges: [
					{ kind: "fee", description: "Referral fee", amount: 2.4 },
					{ kind: "label", description: "Shipping fee", amount: 0 },
				],
			}),
		);
		expect(await saveCostReport(db, fallback)).toBe(true);
		// Fees update; the authoritative $0 label stays.
		expect(await charges(relayedOrder)).toEqual([
			{
				billedBy: "tiktok",
				kind: "fee",
				description: "Referral fee",
				amount: 3,
			},
		]);
		const [onFile] = await db
			.select()
			.from(schema.orderCostReports)
			.where(eq(schema.orderCostReports.orderId, relayedOrder));
		expect(onFile.labelAuthority).toBe("authoritative");
		expect(onFile.labelsPending).toBe(false);

		// Another fallback still can't replace it.
		await saveCostReport(db, { ...fallback, fetchedAt: at(2) });
		expect((await charges(relayedOrder)).map((c) => c.kind)).toEqual(["fee"]);
	});

	test("an authoritative report replaces a fallback's labels", async () => {
		await saveCostReport(
			db,
			report({ labelsAuthoritative: false, labelsPending: true }),
		);
		await saveCostReport(
			db,
			report({
				fetchedAt: at(1),
				charges: [{ kind: "label", description: "Shipping fee", amount: 5 }],
			}),
		);
		expect(await charges(relayedOrder)).toEqual([
			{
				billedBy: "tiktok",
				kind: "label",
				description: "Shipping fee",
				amount: 5,
			},
		]);
	});

	test("refuses a marketplace that didn't sell the order", async () => {
		await expect(
			saveCostReport(db, report({ orderId: shopifyOrder, billedBy: "ebay" })),
		).rejects.toThrow("#1001 wasn't sold on ebay");
		await expect(
			saveCostReport(db, report({ billedBy: "amazon" })),
		).rejects.toThrow("wasn't sold on amazon");
	});

	test("refuses a charge with no amount or description", async () => {
		await expect(
			saveCostReport(
				db,
				report({ charges: [{ kind: "fee", description: "Fee", amount: NaN }] }),
			),
		).rejects.toThrow("Fee has no amount");
		await expect(
			saveCostReport(
				db,
				report({ charges: [{ kind: "fee", description: "  ", amount: 1 }] }),
			),
		).rejects.toThrow("A charge has no description");
		expect(await charges(relayedOrder)).toEqual([]);
	});
});
