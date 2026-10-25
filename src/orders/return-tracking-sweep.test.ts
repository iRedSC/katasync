import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { refreshReturnTracking } from "./return-tracking";

// The four-hourly sweep of return packages, with Shippo stood in for.

let db: Db;
let request: number;
let asked: string[];
let answer: string;

beforeEach(async () => {
	db = await createTestDb();
	const [{ id: store }] = await db
		.insert(schema.stores)
		.values({ channel: "amazon", name: "Amazon" })
		.returning();
	const [o] = await db
		.insert(schema.orders)
		.values({
			storeId: store,
			externalId: "114-1",
			name: "114-1",
			placedAt: new Date(),
			fulfillmentStatus: "FULFILLED",
			total: 0,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	[{ id: request }] = await db
		.insert(schema.returnRequests)
		.values({
			orderId: o.id,
			billedBy: "amazon",
			externalId: "r1",
			status: "shipped",
			waitingOn: "marketplace",
			rawStatus: "Approved",
			trackingNumber: "1Z999AA10123456784",
			carrier: "UPS",
			requestedAt: new Date(),
			sourceUpdatedAt: new Date(),
		})
		.returning();
	asked = [];
	answer = "TRANSIT";
	vi.stubEnv("SHIPPO_API_KEY", "test");
	vi.stubGlobal("fetch", async (url: string) => {
		asked.push(decodeURIComponent(url.split("/").pop() ?? ""));
		if (answer === "DOWN") return new Response("down", { status: 400 });
		return Response.json({ tracking_status: { status: answer } });
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

const saved = async () =>
	(
		await db
			.select()
			.from(schema.returnTracking)
			.where(eq(schema.returnTracking.returnRequestId, request))
	)[0];

test("follows a package until it arrives", async () => {
	await refreshReturnTracking(db);
	expect((await saved())?.status).toBe("TRANSIT");

	answer = "DELIVERED";
	await refreshReturnTracking(db);
	expect((await saved())?.status).toBe("DELIVERED");

	// There: not asked about again.
	expect(await refreshReturnTracking(db)).toEqual({
		checked: 0,
		unsupported: 0,
		failed: [],
		skipped: 1,
	});
	expect(asked).toHaveLength(2);
});

test("a changed number is asked about, and replaces the old answer", async () => {
	answer = "DELIVERED";
	await refreshReturnTracking(db);
	await db
		.update(schema.returnRequests)
		.set({ trackingNumber: "9400100000000000000000", carrier: "USPS" })
		.where(eq(schema.returnRequests.id, request));
	answer = "PRE_TRANSIT";
	await refreshReturnTracking(db);
	expect(asked.at(-1)).toBe("9400100000000000000000");
	expect(await saved()).toMatchObject({
		carrier: "usps",
		number: "9400100000000000000000",
		status: "PRE_TRANSIT",
	});
});

const set = (values: Partial<typeof schema.returnRequests.$inferInsert>) =>
	db
		.update(schema.returnRequests)
		.set(values)
		.where(eq(schema.returnRequests.id, request));

test("a closed request isn't followed", async () => {
	await set({ status: "closed", waitingOn: "nobody" });
	expect(await refreshReturnTracking(db)).toEqual({
		checked: 0,
		unsupported: 0,
		failed: [],
		skipped: 0,
	});
});

test("an unresolved return is followed however long it takes", async () => {
	await set({ requestedAt: new Date(Date.now() - 200 * 86_400_000) });
	expect((await refreshReturnTracking(db)).checked).toBe(1);
});

test("one staff stopped following isn't asked about, until followed again", async () => {
	await set({ unfollowedAt: new Date() });
	await refreshReturnTracking(db);
	expect(asked).toEqual([]);
	await set({ unfollowedAt: null });
	await refreshReturnTracking(db);
	expect(asked).toHaveLength(1);
});

test("a carrier Shippo doesn't follow isn't counted as checked", async () => {
	await set({ carrier: "DHL", trackingNumber: "JD014600006281234567" });
	expect(await refreshReturnTracking(db)).toEqual({
		checked: 0,
		unsupported: 1,
		failed: [],
		skipped: 0,
	});
	expect(asked).toEqual([]);
});

test("a failed ask is reported, keeps the last answer, and is asked again", async () => {
	await refreshReturnTracking(db);
	answer = "DOWN";
	const r = await refreshReturnTracking(db);
	expect(r.checked).toBe(0);
	expect(r.failed).toEqual([
		expect.stringMatching(/^1Z999AA10123456784: Shippo answered 400/),
	]);
	expect((await saved())?.status).toBe("TRANSIT");
	answer = "DELIVERED";
	expect((await refreshReturnTracking(db)).checked).toBe(1);
});

test("one without a number is skipped", async () => {
	await set({ trackingNumber: null });
	expect(await refreshReturnTracking(db)).toEqual({
		checked: 0,
		unsupported: 0,
		failed: [],
		skipped: 1,
	});
});
