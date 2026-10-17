import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { saveCostReport } from "./charges";
import { dueOrders, eachOrder, refreshCosts } from "./cost-refresh";

let db: Db;
let shopify: number;
let tiktok: number;
const now = new Date("2026-10-17T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);

beforeEach(async () => {
	db = await createTestDb();
	[{ id: shopify }, { id: tiktok }] = await db
		.insert(schema.stores)
		.values([
			{ channel: "shopify", name: "Shopify" },
			{ channel: "tiktok", name: "TikTok Shop" },
		])
		.returning();
});

async function order(
	name: string,
	placedHoursAgo: number,
	extra: Partial<typeof schema.orders.$inferInsert> = {},
) {
	const [row] = await db
		.insert(schema.orders)
		.values({
			storeId: shopify,
			externalId: `gid://shopify/Order/${name}`,
			name,
			placedAt: ago(placedHoursAgo),
			fulfillmentStatus: "FULFILLED",
			total: 40,
			sourceUpdatedAt: ago(placedHoursAgo),
			...extra,
		})
		.returning();
	return row.id;
}

const names = async (billedBy: "shopify" | "tiktok", at = now) =>
	(await dueOrders(db, billedBy, at)).map((o) => o.name);

describe("dueOrders", () => {
	test("asks each order's own store and the marketplace it was relayed from", async () => {
		await order("#1", 2);
		await order("#2", 2, { marketplaceOrderId: "tiktok:577" });
		await order("577", 2, {
			storeId: tiktok,
			externalId: "578",
			marketplaceOrderId: "tiktok:578",
		});
		expect(await names("shopify")).toEqual(["#1", "#2"]);
		const asked = await dueOrders(db, "tiktok", now);
		expect(asked.map((o) => [o.name, o.marketplaceId])).toEqual([
			["#2", "577"],
			["577", "578"],
		]);
		expect((await dueOrders(db, "shopify", now))[0].marketplaceId).toBe(
			"gid://shopify/Order/#1",
		);
	});

	test("leaves out cancelled orders and ones old enough to be final", async () => {
		await order("#cancelled", 2, { cancelledAt: ago(1) });
		await order("#old", 61 * 24);
		await order("#open", 2);
		expect(await names("shopify")).toEqual(["#open"]);
	});

	test("keeps asking after TikTok settles, since refunds come later", async () => {
		const settled = await order("#settled", 2);
		await saveCostReport(db, {
			orderId: settled,
			billedBy: "shopify",
			settled: true,
			charges: [],
		});
		expect(await names("shopify")).toEqual(["#settled"]);
	});

	test("backs off to a quarter of the order's age, between an hour and a week", async () => {
		await order("#young", 2);
		await order("#week", 7 * 24);
		await order("#month", 40 * 24);
		await refreshCosts(db, "shopify", async () => [], { now });
		const later = (hours: number) =>
			names("shopify", new Date(now.getTime() + hours * HOUR));
		expect(await names("shopify")).toEqual([]);
		// Two hours old: due again in an hour.
		expect(await later(1)).toEqual(["#young"]);
		// A week old: due once the wait is a quarter of its age by then, 56
		// hours on.
		expect(await later(55)).not.toContain("#week");
		expect(await later(56)).toContain("#week");
		// Forty days old: a week, not ten days.
		expect(await later(7 * 24 - 1)).not.toContain("#month");
		expect(await later(7 * 24)).toContain("#month");
	});
});

describe("refreshCosts", () => {
	test("saves reports, skips marketplaces with nothing yet, and keeps errors", async () => {
		const reported = await order("#reported", 2);
		const pending = await order("#pending", 3);
		const broken = await order("#broken", 4);
		const result = await refreshCosts(
			db,
			"shopify",
			eachOrder(async (o) => {
				if (o.orderId === broken) throw new Error("ShopifyQL timed out");
				if (o.orderId === pending) return null;
				return {
					settled: false,
					charges: [{ kind: "fee", description: "Processing", amount: 1.46 }],
				};
			}),
			{ now },
		);
		expect(result).toEqual({
			checked: 3,
			reported: 1,
			problems: ["#broken: ShopifyQL timed out"],
		});
		const reports = await db.select().from(schema.orderCostReports);
		expect(reports.map((r) => r.orderId)).toEqual([reported]);
		const [check] = await db
			.select()
			.from(schema.orderCostChecks)
			.where(eq(schema.orderCostChecks.orderId, broken));
		expect(check.error).toBe("ShopifyQL timed out");
	});
});

test("a batch that fails as a whole marks every order", async () => {
	await order("#a", 2);
	await order("#b", 3);
	const result = await refreshCosts(
		db,
		"shopify",
		async () => {
			throw new Error("Shopify login failed");
		},
		{ now },
	);
	expect(result.problems).toEqual([
		"#a: Shopify login failed",
		"#b: Shopify login failed",
	]);
	expect(await names("shopify", new Date(now.getTime() + HOUR))).toEqual([
		"#a",
		"#b",
	]);
});

test("history asks once about orders too old for passes, never asked before", async () => {
	await order("#recent", 2);
	await order("#old", 90 * 24);
	await order("#older", 300 * 24);
	const asked: string[] = [];
	const fetch = eachOrder(async (o) => {
		asked.push(o.name);
		return null;
	});
	await refreshCosts(db, "shopify", fetch, { now, history: true });
	expect(asked).toEqual(["#old", "#older"]);
	await refreshCosts(db, "shopify", fetch, { now, history: true });
	expect(asked).toHaveLength(2);
});

test("history asks again about old orders whose last ask failed", async () => {
	await order("#old", 90 * 24);
	let fail = true;
	const fetch = eachOrder(async () => {
		if (fail) throw new Error("Amazon throttled");
		return null;
	});
	await refreshCosts(db, "shopify", fetch, { now, history: true });
	fail = false;
	const soon = new Date(now.getTime() + 30 * 60 * 1000);
	const later = new Date(now.getTime() + 2 * HOUR);
	expect(
		(await refreshCosts(db, "shopify", fetch, { now: soon, history: true }))
			.checked,
	).toBe(0);
	expect(
		(await refreshCosts(db, "shopify", fetch, { now: later, history: true }))
			.checked,
	).toBe(1);
	expect(
		(await refreshCosts(db, "shopify", fetch, { now: later, history: true }))
			.checked,
	).toBe(0);
});
