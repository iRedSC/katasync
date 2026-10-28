import { expect, test } from "vitest";
import {
	amazonReturnStage,
	EBAY_CASE_STATES,
	ebayReturnStage,
	SHOPIFY_CASE_STATES,
	shopifyReturnStage,
} from "#/channels/marketplace-case-stage";
import {
	TIKTOK_RETURN_STATES,
	tiktokReturnStage,
} from "#/channels/tiktok-case-stage";
import { feedHealth, openCases, returnRequests } from "#/db/schema";
import { createTestDb } from "#/test/db";

// Each upgrade replays the complete migration history on a fresh database.
const UPGRADE_TIMEOUT_MS = 20000;

test(
	"upgrade from before #236 reopens legacy SUCCESS and preserves both pending refunds",
	async () => {
		const db = await createTestDb({
			beforeMigration: 141,
			seed: async (pg) => {
				await pg.query(
					"INSERT INTO stores (channel, name) VALUES ('tiktok', 'Upgrade')",
				);
				await pg.query(`INSERT INTO orders (store_id, external_id, name, placed_at, fulfillment_status, total, source_updated_at)
				SELECT id, 'order', 'order', now(), 'FULFILLED', 0, now() FROM stores WHERE name = 'Upgrade'`);
				const rows = [
					["legacy-success", "RETURN_OR_REFUND_REQUEST_SUCCESS"],
					["4035352486720738032", "RETURN_OR_REFUND_REQUEST_PENDING"],
					["4035353434457018423", "RETURN_OR_REFUND_REQUEST_PENDING"],
					["unknown", "FUTURE_SUCCESS"],
					["settled", "RETURN_OR_REFUND_REQUEST_COMPLETE"],
				];
				for (const [id, raw] of rows)
					await pg.query(
						`INSERT INTO return_requests
				(order_id, billed_by, external_id, status, raw_status, requested_at, source_updated_at)
				SELECT id, 'tiktok', $1, 'closed', $2, '2025-01-01', now() FROM orders`,
						[id, raw],
					);
			},
		});
		expect(
			await db.select().from(openCases).orderBy(openCases.externalId),
		).toMatchObject([
			{
				externalId: "4035352486720738032",
				kind: "refund",
				status: "requested",
				waitingOn: "us",
				respondBy: null,
			},
			{
				externalId: "4035353434457018423",
				kind: "refund",
				status: "requested",
				waitingOn: "us",
				respondBy: null,
			},
			{
				externalId: "legacy-success",
				status: "processing",
				waitingOn: "marketplace",
				respondBy: null,
			},
			{
				externalId: "unknown",
				status: "unknown",
				waitingOn: "marketplace",
				respondBy: null,
			},
		]);
	},
	UPGRADE_TIMEOUT_MS,
);

test(
	"upgrade from main preserves coverage and unread-note retries",
	async () => {
		const db = await createTestDb({
			beforeMigration: 145,
			seed: async (pg) => {
				await pg.query(
					"INSERT INTO stores (channel, name) VALUES ('tiktok', 'Upgrade')",
				);
				await pg.query(`INSERT INTO orders (store_id, external_id, name, placed_at, fulfillment_status, total, source_updated_at)
				SELECT id, 'order', 'order', now(), 'FULFILLED', 0, now() FROM stores WHERE name = 'Upgrade'`);
				await pg.query(`INSERT INTO return_requests
				(order_id, billed_by, external_id, kind, status, raw_status, note, note_unread, requested_at, source_updated_at)
				SELECT id, 'tiktok', 'legacy-refund', 'refund', 'closed', 'RETURN_OR_REFUND_REQUEST_SUCCESS', 'Keep this note', true, '2025-01-01', '2026-10-20' FROM orders`);
				await pg.query(`INSERT INTO feed_health (channel, feed, state, attempted_at, succeeded_at, read_through)
				VALUES ('tiktok', 'returns', 'pending', '2026-10-25', '2026-10-24', '2026-10-24')`);
			},
		});
		expect(await db.select().from(returnRequests)).toMatchObject([
			{
				kind: "refund",
				status: "processing",
				waitingOn: "marketplace",
				note: "Keep this note",
				recordsUnread: true,
				sourceUpdatedAt: new Date("2026-10-20T00:00:00Z"),
			},
		]);
		expect(await db.select().from(feedHealth)).toMatchObject([
			{ state: "pending", readThrough: new Date("2026-10-24T00:00:00Z") },
		]);
	},
	UPGRADE_TIMEOUT_MS,
);

test(
	"upgrade to kept records asks again for every TikTok case's records, and versions its saves",
	async () => {
		const db = await createTestDb({
			beforeMigration: 151,
			seed: async (pg) => {
				await pg.query(
					"INSERT INTO stores (channel, name) VALUES ('tiktok', 'TikTok'), ('ebay', 'eBay')",
				);
				await pg.query(`INSERT INTO orders (store_id, external_id, name, placed_at, fulfillment_status, total, source_updated_at)
				SELECT id, channel::text, channel::text, now(), 'FULFILLED', 0, now() FROM stores`);
				await pg.query(`INSERT INTO return_requests
				(order_id, billed_by, external_id, kind, status, waiting_on, raw_status, note, note_unread, requested_at, source_updated_at)
				SELECT o.id, s.channel, 'R-' || s.channel::text, 'return', 'requested', 'us', 'OPEN', 'Kept', false, '2026-10-01', '2026-10-20'
				FROM orders o JOIN stores s ON s.id = o.store_id`);
			},
		});
		const rows = await db
			.select()
			.from(returnRequests)
			.orderBy(returnRequests.billedBy);
		expect(
			rows.map((r) => [r.billedBy, r.recordsUnread, r.sourceVersioned, r.note]),
		).toEqual([
			["ebay", false, false, "Kept"],
			["tiktok", true, true, "Kept"],
		]);
	},
	UPGRADE_TIMEOUT_MS,
);

test(
	"upgrade ownership mirrors raw marketplace mappings rather than collapsed requested stages",
	async () => {
		const cases = [
			...Object.keys(TIKTOK_RETURN_STATES).map((raw) => ({
				channel: "tiktok",
				raw,
				expected: tiktokReturnStage({ return_status: raw }),
			})),
			...Object.keys(EBAY_CASE_STATES).map((raw) => ({
				channel: "ebay",
				raw,
				expected: ebayReturnStage(raw),
			})),
			...Object.keys(SHOPIFY_CASE_STATES).map((raw) => ({
				channel: "shopify",
				raw,
				expected: shopifyReturnStage(raw, false),
			})),
			...["Pending", "Approved", "Rejected", "Closed", "FUTURE"].map((raw) => ({
				channel: "amazon",
				raw,
				expected: amazonReturnStage({
					status: raw,
					tracked: false,
					delivered: false,
				}),
			})),
		];
		const db = await createTestDb({
			beforeMigration: 142,
			seed: async (pg) => {
				await pg.query(
					"INSERT INTO stores (channel, name) VALUES ('tiktok', 'Upgrade')",
				);
				await pg.query(`INSERT INTO orders (store_id, external_id, name, placed_at, fulfillment_status, total, source_updated_at)
				SELECT id, 'order', 'order', now(), 'FULFILLED', 0, now() FROM stores WHERE name = 'Upgrade'`);
				for (const row of cases)
					await pg.query(
						`INSERT INTO return_requests
				(order_id, billed_by, external_id, status, raw_status, requested_at, source_updated_at)
				SELECT id, $1::channel, $2, 'requested', $3, now(), now() FROM orders`,
						[row.channel, `${row.channel}:${row.raw}`, row.raw],
					);
			},
		});
		const saved = await db.select().from(returnRequests);
		for (const row of cases)
			expect(
				saved.find((value) => value.externalId === `${row.channel}:${row.raw}`),
				`${row.channel}:${row.raw}`,
			).toMatchObject({
				status: row.expected.status,
				waitingOn: row.expected.waitingOn,
				respondBy: null,
			});
	},
	UPGRADE_TIMEOUT_MS,
);
