import { beforeEach, expect, test, vi } from "vitest";

vi.mock("./tiktok", () => ({
	shopCipher: vi.fn(async () => "cipher"),
	tiktokApi: vi.fn(),
}));

import type { Db } from "#/db/client";
import { feedHealth, orders, returnRequests, stores } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { returnsPass } from "./returns-pass";
import { tiktokApi } from "./tiktok";

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
});

test("aftersales cases retain selective note retries, partial feedback and verified coverage", async () => {
	const now = new Date("2026-10-25T12:00:00Z");
	const [store] = await db
		.insert(stores)
		.values({ channel: "tiktok", name: "TikTok" })
		.returning();
	await db.insert(orders).values({
		storeId: store.id,
		externalId: "order",
		name: "order",
		placedAt: now,
		fulfillmentStatus: "FULFILLED",
		total: 27.87,
		sourceUpdatedAt: now,
	});
	const request = {
		return_id: "4035353434457018423",
		order_id: "order",
		return_type: "REFUND",
		return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
		create_time: 1792000000,
		update_time: 1792800000,
		seller_next_action_response: [
			{ action: "SELLER_RESPOND_REFUND", deadline: 1793164840 },
		],
		refund_amount: { currency: "USD", refund_total: "27.87" },
	};
	let notesOnline = false;
	let truncated = false;
	let notesRead = 0;
	vi.mocked(tiktokApi).mockImplementation(async (endpoint) => {
		if (endpoint === "/return_refund/202603/aftersales/search")
			return {
				aftersales_requests: [
					{
						id: "parent",
						status: "PENDING_REQUEST_REVIEW",
						sku_return_requests: [request],
					},
				],
				total_count: truncated ? 2 : 1,
			};
		if (endpoint === "/return_refund/202604/rma/search")
			return { return_merchandise_authorizations: [], total_count: 0 };
		notesRead++;
		if (!notesOnline) throw new Error("notes offline");
		return { records: [{ role: "BUYER", note: "Missing item" }] };
	});
	const run = (offset: number) =>
		returnsPass(db, "tiktok", {
			now: new Date(now.getTime() + offset * 900000),
		});
	const saved = async () => (await db.select().from(returnRequests))[0];
	const health = async () => (await db.select().from(feedHealth))[0];
	expect(await run(0)).toMatchObject({
		kind: "read",
		problems: [
			expect.stringContaining("notes offline"),
			expect.stringContaining("notes offline"),
		],
	});
	expect(await saved()).toMatchObject({
		caseRef: "parent",
		kind: "refund",
		waitingOn: "us",
		amount: "27.87",
		respondBy: new Date(1793164840000),
		noteUnread: true,
		sourceUpdatedAt: new Date(1792800000000),
	});
	expect(await health()).toMatchObject({ state: "partial", readThrough: now });
	notesOnline = true;
	await run(1);
	expect(await saved()).toMatchObject({
		noteUnread: false,
		note: "Missing item",
	});
	expect(await health()).toMatchObject({ state: "ok" });
	const afterRetry = notesRead;
	await run(2);
	expect(notesRead).toBe(afterRetry);
	request.update_time++;
	request.seller_next_action_response[0].deadline++;
	await run(3);
	expect(notesRead).toBe(afterRetry + 1);
	expect(await saved()).toMatchObject({
		respondBy: new Date(1793164841000),
		sourceUpdatedAt: new Date(1792800001000),
	});
	const verified = (await health()).readThrough;
	truncated = true;
	expect(await run(4)).toMatchObject({
		kind: "failed",
		error: expect.stringContaining("truncated"),
	});
	expect(await health()).toMatchObject({
		state: "failed",
		readThrough: verified,
	});
	expect(notesRead).toBe(afterRetry + 1);
});
