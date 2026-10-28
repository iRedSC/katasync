import { vi } from "vitest";
import { tiktokApi } from "#/channels/tiktok";
import { refreshTiktokCase } from "#/channels/tiktok-case-refresh";
import {
	type Fetched,
	type ReadRecords,
	returnRecords,
} from "#/channels/tiktok-return-records";
import type { Db } from "#/db/client";
import {
	feedHealth,
	orders,
	returnRequestMedia,
	returnRequests,
	stores,
} from "#/db/schema";
import { createTestDb } from "./db";

// One TikTok refund case as the aftersales API, records API and its media
// hosts serve it, for tests of webhook refreshes and evidence. The test file
// mocks "#/channels/tiktok" (shopCipher, tiktokApi); this answers for it.

export const CASE = "4035352489823474416";
export const RETURN = "4035352486720738032";
export const ORDER = "577620148777947888";

let signature = 0;
export const photo = (n: number) =>
	`https://p16-oec-general-useast5.ttcdn-us.com/tos-useast5-i/${n}~tplv-origin-jpeg.jpeg?shp=sig${++signature}`;

export const jpeg = (body = "jpeg"): Fetched => ({
	kind: "kept",
	contentType: "image/jpeg",
	data: Buffer.from(body),
});

export async function tiktokCase() {
	const db: Db = await createTestDb();
	const now = new Date("2026-10-25T12:00:00Z");
	const [store] = await db
		.insert(stores)
		.values({ channel: "tiktok", name: "TikTok" })
		.returning();
	await db.insert(orders).values({
		storeId: store.id,
		externalId: ORDER,
		name: ORDER,
		placedAt: now,
		fulfillmentStatus: "FULFILLED",
		total: 101.77,
		sourceUpdatedAt: now,
	});
	const world = {
		db,
		store,
		request: {
			return_id: RETURN,
			order_id: ORDER,
			return_type: "REFUND",
			return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
			create_time: 1792518879,
			update_time: 1792800000 as number | undefined,
			seller_next_action_response: [
				{ action: "SELLER_RESPOND_REFUND", deadline: 1793037279 },
			] as { action: string; deadline: number }[],
			refund_amount: { currency: "USD", refund_total: "101.77" },
		},
		records: {
			records: [
				{
					create_time: 1792518879,
					role: "BUYER",
					event: "ORDER_REFUND",
					description: "refund request submitted by customer",
					reason_text: "Missing items",
					note: "Only one came",
					images: [
						{ url: photo(1), width: 200, height: 200 },
						{ url: photo(2), width: 200, height: 200 },
					],
					videos: [
						{
							url: "https://v16m-default.akamaized.net/1e26/65005d33/video/v",
							cover: photo(3),
							duration_millis: 3000,
						},
					],
				},
				{ create_time: 1792600000, role: "SELLER", event: "ORDER_REFUND" },
			],
		} as unknown,
		downloads: [] as string[],
		serve: (_url: string): Fetched => jpeg(),
	};
	// Each read hands out fresh links, as TikTok does.
	const fresh = (body: unknown) =>
		JSON.parse(
			JSON.stringify(body).replace(
				/shp=sig\d+/g,
				() => `shp=sig${++signature}`,
			),
		);
	const api = vi.mocked(tiktokApi);
	api.mockReset();
	api.mockImplementation(async (endpoint, _query, body) => {
		if (endpoint === "/return_refund/202603/aftersales/search") {
			const filters = (body as { filters: Record<string, string[]> }).filters;
			// A pass's window finds it too.
			const named =
				"time" in filters ||
				filters.aftersales_request_ids?.includes(CASE) ||
				filters.main_order_ids?.includes(ORDER);
			return named
				? {
						aftersales_requests: [
							{
								id: CASE,
								status: "PENDING_REQUEST_REVIEW",
								sku_return_requests: [{ ...world.request }],
							},
						],
						total_count: 1,
					}
				: { aftersales_requests: [], total_count: 0 };
		}
		if (endpoint === "/return_refund/202604/rma/search")
			return { return_merchandise_authorizations: [], total_count: 0 };
		if (/^\/return_refund\/202309\/returns\/\w+\/records$/.test(endpoint))
			return fresh(world.records);
		throw new Error(`unexpected ${endpoint}`);
	});
	const readRecords: ReadRecords = async (wanted) => {
		const read = new Map();
		const failed: { id: string; error: string }[] = [];
		for (const w of wanted)
			try {
				read.set(
					w.id,
					await returnRecords("cipher", w.id, w.prior, async (url) => {
						world.downloads.push(url);
						return world.serve(url);
					}),
				);
			} catch (error) {
				failed.push({ id: w.id, error: String(error) });
			}
		return { read, failed };
	};
	return {
		db,
		world,
		api,
		readRecords,
		refresh: (kind: "aftersales" | "order_returns", id: string) =>
			refreshTiktokCase(db, { kind, id }, { readRecords }),
		saved: async () => (await db.select().from(returnRequests))[0],
		health: () => db.select().from(feedHealth),
		media: () =>
			db
				.select({
					kind: returnRequestMedia.kind,
					url: returnRequestMedia.url,
					recordId: returnRequestMedia.recordId,
					copy: returnRequestMedia.copy,
					failedFetches: returnRequestMedia.failedFetches,
					coverUrl: returnRequestMedia.coverUrl,
					durationMs: returnRequestMedia.durationMs,
					data: returnRequestMedia.data,
				})
				.from(returnRequestMedia)
				.orderBy(returnRequestMedia.recordId, returnRequestMedia.position),
	};
}
