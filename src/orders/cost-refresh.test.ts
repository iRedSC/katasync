import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { saveCostReport } from "./charges";
import {
	dueOrders,
	eachOrder,
	refreshCosts,
	sweepPosted,
} from "./cost-refresh";

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

describe("sweepPosted", () => {
	async function amazonOrder(name: string, placedHoursAgo: number) {
		const [{ id: store }] = await db
			.insert(schema.stores)
			.values({ channel: "amazon", name: `Amazon ${name}` })
			.returning();
		return order(name, placedHoursAgo, {
			storeId: store,
			externalId: name,
			marketplaceOrderId: `amazon:${name}`,
		});
	}
	const report = (orderId: number, fetchedAt: Date) =>
		saveCostReport(db, {
			orderId,
			billedBy: "amazon",
			settled: false,
			charges: [{ kind: "label", description: "Postage", amount: 7 }],
			fetchedAt,
		});

	test("asks again about orders with money posted after their report, however old", async () => {
		// A re-bill posted on a sale 70 days old, past the regular passes.
		const old = await amazonOrder("111-old", 70 * 24);
		await report(old, ago(20 * 24));
		// Its report came after what posted, recently enough to wait.
		const current = await amazonOrder("111-current", 20 * 24);
		await report(current, ago(1));
		// Asked an hour after the posting, which may not have shown yet.
		const close = await amazonOrder("111-close", 20 * 24);
		await report(close, ago(23));
		const settled = await amazonOrder("111-settled", 20 * 24);
		await report(settled, ago(10));
		const asked: string[] = [];
		const result = await sweepPosted(
			db,
			"amazon",
			eachOrder(async (o) => {
				asked.push(o.marketplaceId);
				return {
					settled: false,
					charges: [
						{
							kind: "postage_adjustment",
							description: "PostageBilling_PostageAdjustment",
							amount: 12.5,
						},
					],
				};
			}),
			async (since) => {
				expect(since).toEqual(ago(3 * 24));
				return [
					// Its report came 60 hours after, past any lag.
					{ marketplaceId: "111-settled", postedAt: ago(70) },
					{ marketplaceId: "111-old", postedAt: ago(2 * 24) },
					{ marketplaceId: "111-current", postedAt: ago(30) },
					{ marketplaceId: "111-close", postedAt: ago(24) },
					// Not one of ours.
					{ marketplaceId: "999-unknown", postedAt: ago(5) },
				];
			},
			{ now },
		);
		expect(asked.sort()).toEqual(["111-close", "111-old"]);
		expect(result).toMatchObject({ checked: 2, reported: 2 });
		const charges = await db
			.select()
			.from(schema.orderCharges)
			.where(eq(schema.orderCharges.orderId, old));
		expect(charges.map((c) => c.kind)).toEqual(["postage_adjustment"]);
	});

	test("a backlog goes in saved batches and stops at the deadline", async () => {
		for (const name of ["111-a", "111-b", "111-c"])
			await amazonOrder(name, 30 * 24);
		const fetch = eachOrder(async () => ({ settled: false, charges: [] }));
		const list = async () =>
			["111-a", "111-b", "111-c"].map((marketplaceId) => ({
				marketplaceId,
				postedAt: ago(5),
			}));
		const first = await sweepPosted(db, "amazon", fetch, list, {
			now,
			limit: 2,
			until: 0,
		});
		expect(first.checked).toBe(2);
		const next = await sweepPosted(db, "amazon", fetch, list, { now });
		expect(next.checked).toBe(1);
	});

	test("orders that keep failing go last, so they can't hold up the rest", async () => {
		const names = ["111-bad1", "111-bad2", "111-good"];
		for (const name of names) await amazonOrder(name, 70 * 24);
		const asked: string[] = [];
		const fetch = eachOrder(async (o) => {
			asked.push(o.marketplaceId);
			if (o.marketplaceId.startsWith("111-bad")) throw new Error("Bad data");
			return { settled: false, charges: [] };
		});
		const list = async () =>
			names.map((marketplaceId) => ({ marketplaceId, postedAt: ago(5) }));
		// The first pass happens to take the failing ones alone, and stops.
		const first = await sweepPosted(db, "amazon", fetch, list, {
			now,
			limit: 2,
		});
		expect(first.checked).toBe(2);
		expect(asked.sort()).toEqual(["111-bad1", "111-bad2"]);
		asked.length = 0;
		const next = await sweepPosted(db, "amazon", fetch, list, {
			now: new Date(now.getTime() + 4 * HOUR),
			limit: 2,
		});
		expect(asked[0]).toBe("111-good");
		expect(next.reported).toBe(1);
	});
});
