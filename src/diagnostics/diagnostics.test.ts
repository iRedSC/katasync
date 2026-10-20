import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { addDispatch, createTestDb } from "#/test/db";
import { dismiss, restore } from "./dismissals";
import {
	channelHealth,
	groupIssues,
	hintFor,
	type Run,
	STALE_AFTER_MINUTES,
	WORKER_QUIET_MINUTES,
	workerAlive,
} from "./health";
import { diagnosticsAttention, diagnosticsOverview } from "./overview";
import {
	errorText,
	MAX_ISSUES_PER_RUN,
	recordSyncRun,
	splitProblem,
} from "./runs";

const now = new Date("2026-10-10T12:00:00Z");
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);
const run = (ago: number, extra: Partial<Run> = {}): Run => ({
	startedAt: minutesAgo(ago),
	finishedAt: minutesAgo(ago - 1),
	problems: 0,
	error: null,
	...extra,
});

describe("channelHealth", () => {
	const base = { configured: true, now };

	test("healthy, degraded, and never synced", () => {
		expect(
			channelHealth({ ...base, runs: [run(3)], lastSuccessAt: minutesAgo(2) })
				.health,
		).toBe("healthy");
		expect(
			channelHealth({
				...base,
				runs: [run(3, { problems: 4 })],
				lastSuccessAt: minutesAgo(2),
			}).health,
		).toBe("degraded");
		expect(
			channelHealth({ ...base, runs: [], lastSuccessAt: null }).health,
		).toBe("never_synced");
		expect(
			channelHealth({ configured: false, now, runs: [], lastSuccessAt: null })
				.health,
		).toBe("not_connected");
	});

	test("failing says since when, and ignores a run still going", () => {
		const s = channelHealth({
			...base,
			runs: [
				{ ...run(1), finishedAt: null },
				run(3, { error: "eBay answered 500" }),
				run(5, { error: "eBay answered 500" }),
				run(7),
			],
			lastSuccessAt: minutesAgo(6),
		});
		expect(s).toMatchObject({
			health: "failing",
			consecutiveFailures: 2,
			failingSince: minutesAgo(5),
			latestError: "eBay answered 500",
		});
	});

	test("stale when the last good pass is old, even without errors", () => {
		expect(
			channelHealth({
				...base,
				runs: [run(STALE_AFTER_MINUTES + 2)],
				lastSuccessAt: minutesAgo(STALE_AFTER_MINUTES + 1),
			}).health,
		).toBe("stale");
	});

	test("the worker is alive while passes keep starting", () => {
		expect(workerAlive(minutesAgo(3), now)).toBe(true);
		expect(workerAlive(minutesAgo(WORKER_QUIET_MINUTES + 1), now)).toBe(false);
		expect(workerAlive(null, now)).toBe(false);
	});
});

test("hints for known failures", () => {
	expect(
		hintFor("ebay", 'eBay login failed: 400 {"error":"invalid_grant"}')?.action,
	).toMatch(/quoted/);
	expect(hintFor("shopify", "Set SHOPIFY_ADMIN_TOKEN")?.action).toMatch(
		/SHOPIFY_ADMIN_TOKEN/,
	);
	expect(hintFor("shopify", "Shopify error: ACCESS_DENIED")?.action).toMatch(
		/Develop apps/,
	);
	expect(hintFor("amazon", "TypeError: fetch failed")?.title).toMatch(/reach/);
	expect(hintFor("amazon", "something new")).toBeNull();
});

test("problems split into order and message, and group by message", () => {
	expect(splitProblem("#5536: no product for KNIFE-5")).toEqual({
		reference: "#5536",
		message: "no product for KNIFE-5",
	});
	expect(splitProblem("odd")).toEqual({ reference: null, message: "odd" });
	expect(
		groupIssues([
			{ reference: "#1", message: "no product for A" },
			{ reference: "#2", message: "no product for B" },
			{ reference: "#3", message: "no product for B" },
		]),
	).toEqual([
		{ message: "no product for B", count: 2, references: ["#2", "#3"] },
		{ message: "no product for A", count: 1, references: ["#1"] },
	]);
});

describe("recording runs", () => {
	let db: Db;
	beforeEach(async () => {
		db = await createTestDb();
	});

	test("records a pass, caps its issue rows, and keeps the exact count", async () => {
		const problems = Array.from(
			{ length: MAX_ISSUES_PER_RUN + 5 },
			(_, i) => `#${i}: no product for X`,
		);
		await recordSyncRun(
			db,
			"ebay",
			async () => ({ store: "eBay US", orders: 3, problems }),
			() => now,
		);
		const [saved] = await db.select().from(schema.syncRuns);
		expect(saved).toMatchObject({
			channel: "ebay",
			orders: 3,
			problems: MAX_ISSUES_PER_RUN + 5,
			error: null,
			finishedAt: now,
		});
		expect(await db.select().from(schema.syncIssues)).toHaveLength(
			MAX_ISSUES_PER_RUN,
		);
	});

	test("records a failure and throws it on", async () => {
		await expect(
			recordSyncRun(
				db,
				"amazon",
				async () => {
					throw new Error("Amazon login failed: 400\n    at accessToken");
				},
				() => now,
			),
		).rejects.toThrow(/login failed/);
		const [saved] = await db.select().from(schema.syncRuns);
		expect(saved.error).toBe("Amazon login failed: 400");
	});

	test("the overview reads failing channels and their hint", async () => {
		process.env.EBAY_CLIENT_ID = "id";
		process.env.EBAY_CLIENT_SECRET = "secret";
		process.env.EBAY_REFRESH_TOKEN = "v^1.1#i^1#r^1";
		try {
			await recordSyncRun(
				db,
				"ebay",
				async () => ({ store: "eBay US", orders: 1, problems: [] }),
				() => minutesAgo(5),
			);
			await recordSyncRun(
				db,
				"ebay",
				async () => {
					throw new Error("eBay login failed: 400 invalid_grant");
				},
				() => minutesAgo(2),
			).catch(() => {});
			const o = await diagnosticsOverview(db, now);
			const ebay = o.channels.find((c) => c.channel === "ebay");
			expect(ebay).toMatchObject({
				health: "failing",
				consecutiveFailures: 1,
				lastSuccessAt: minutesAgo(5),
			});
			expect(ebay?.hint?.title).toMatch(/eBay refused/);
			expect(o.worker.alive).toBe(true);
		} finally {
			delete process.env.EBAY_CLIENT_ID;
			delete process.env.EBAY_CLIENT_SECRET;
			delete process.env.EBAY_REFRESH_TOKEN;
		}
	});
});

test("lists labels whose storefront tracking entry needs fixing, voided or not", async () => {
	const db = await createTestDb();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: "gid://shopify/Order/9",
			name: "#9",
			placedAt: now,
			fulfillmentStatus: "FULFILLED",
			total: 30,
			sourceUpdatedAt: now,
		})
		.returning();
	const label = (
		n: number,
		extra: Partial<typeof schema.shipments.$inferInsert>,
	) => ({
		lengthMm: 300,
		widthMm: 200,
		heightMm: 100,
		weightGrams: 600,
		provider: "shippo",
		carrier: "USPS",
		carrierToken: "usps",
		service: "usps_ground_advantage",
		serviceName: "USPS Ground Advantage",
		cost: 7,
		trackingNumber: `940${n}`,
		externalId: `tx-${n}`,
		test: false,
		...extra,
	});
	const before = await diagnosticsAttention(db, now);
	const dispatch = await addDispatch(db, {
		orderIds: [order.id],
		boxes: [
			label(1, {}),
			label(2, { storefrontTrackingError: "not saved" }),
			label(3, { storefrontTrackingError: "not removed", voidedAt: now }),
		],
	});
	await db
		.update(schema.dispatchOrders)
		.set({ channelSentAt: now })
		.where(eq(schema.dispatchOrders.dispatchId, dispatch.dispatchId));

	const o = await diagnosticsOverview(db, now);
	expect(
		o.storefrontTracking.map((r) => [r.trackingNumber, r.voided, r.error]),
	).toEqual(
		expect.arrayContaining([
			["9402", false, "not saved"],
			["9403", true, "not removed"],
		]),
	);
	expect(o.storefrontTracking).toHaveLength(2);
	expect(o.handoffs).toHaveLength(0);
	expect(await diagnosticsAttention(db, now)).toBe(before + 1);
});

test("a dismissed label stays hidden until its error changes", async () => {
	const db = await createTestDb();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: "gid://shopify/Order/9",
			name: "#9",
			placedAt: now,
			fulfillmentStatus: "FULFILLED",
			total: 30,
			sourceUpdatedAt: now,
		})
		.returning();
	const dispatch = await addDispatch(db, {
		orderIds: [order.id],
		boxes: [
			{
				lengthMm: 300,
				widthMm: 200,
				heightMm: 100,
				weightGrams: 600,
				provider: "shippo",
				carrier: "USPS",
				service: "usps_ground_advantage",
				serviceName: "USPS Ground Advantage",
				cost: 7,
				externalId: "tx-1",
				test: false,
				storefrontTrackingError: "not saved",
			},
		],
	});
	await db
		.update(schema.dispatchOrders)
		.set({ channelSentAt: now })
		.where(eq(schema.dispatchOrders.dispatchId, dispatch.dispatchId));
	const [shipment] = await db.select().from(schema.shipments);
	const before = await diagnosticsAttention(db, now);
	const dismissed = async () =>
		(await diagnosticsOverview(db, now)).storefrontTracking.map(
			(r) => r.dismissed,
		);

	await dismiss(db, { kind: "storefront", shipmentId: shipment.id });
	expect(await dismissed()).toEqual([true]);
	expect(await diagnosticsAttention(db, now)).toBe(before - 1);

	await db
		.update(schema.shipments)
		.set({ storefrontTrackingError: "not saved: 500" })
		.where(eq(schema.shipments.id, shipment.id));
	expect(await dismissed()).toEqual([false]);

	await dismiss(db, { kind: "storefront", shipmentId: shipment.id });
	await restore(db, { kind: "storefront", shipmentId: shipment.id });
	expect(await dismissed()).toEqual([false]);
});

test("a dismissed sync issue shows again on a new order", async () => {
	const db = await createTestDb();
	const pass = (problems: string[], at: number) =>
		recordSyncRun(
			db,
			"ebay",
			async () => ({ store: "eBay US", orders: 3, problems }),
			() => minutesAgo(at),
		);
	const issues = async () =>
		(await diagnosticsOverview(db, now)).channels
			.find((c) => c.channel === "ebay")
			?.issues.map((g) => [g.message, g.count, g.dismissed]);

	await pass(["#1: no location to take stock from"], 4);
	await dismiss(db, {
		kind: "issue",
		channel: "ebay",
		message: "no location to take stock from",
	});
	await pass(
		[
			"#1: no location to take stock from",
			"#2: no location to take stock from",
			"#3: no product for KNIFE",
		],
		2,
	);
	expect(await issues()).toEqual(
		expect.arrayContaining([
			["no location to take stock from", 1, false],
			["no location to take stock from", 1, true],
			["no product for KNIFE", 1, false],
		]),
	);
});

describe("errorText", () => {
	test("puts the cause first, so a long query can't cut it off", () => {
		const cause = new Error("duplicate key value violates unique constraint");
		const error = new Error(`Failed query: ${"x".repeat(5000)}`, { cause });
		const text = errorText(error);
		expect(text.startsWith(cause.message)).toBe(true);
		expect(text.length).toBeLessThanOrEqual(2001);
	});
});
