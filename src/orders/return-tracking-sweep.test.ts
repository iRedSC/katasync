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
	expect(await refreshReturnTracking(db)).toEqual({ checked: 0, problems: [] });
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

test("a closed request isn't followed", async () => {
	await db
		.update(schema.returnRequests)
		.set({ status: "closed", waitingOn: "nobody" })
		.where(eq(schema.returnRequests.id, request));
	expect(await refreshReturnTracking(db)).toEqual({ checked: 0, problems: [] });
});
