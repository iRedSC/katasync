import { beforeEach, expect, test, vi } from "vitest";

vi.mock("./tiktok", () => ({
	shopCipher: vi.fn(async () => "cipher"),
	tiktokApi: vi.fn(),
}));

import { tiktokApi } from "./tiktok";
import { fetchTiktokReturns, withBuyerNotes } from "./tiktok-returns";

const from = new Date("2026-10-18T00:00:00Z");
const until = new Date("2026-10-25T00:00:00Z");
const sku = {
	return_id: "4035352486720738032",
	order_id: "577620148777947888",
	return_type: "REFUND",
	return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
	create_time: 1792000000,
	update_time: 1792800000,
	seller_next_action_response: [
		{ action: "SELLER_RESPOND_REFUND", deadline: 1793037279 },
	],
	refund_amount: {
		currency: "USD",
		refund_total: "101.77",
		refund_subtotal: "101.77",
		refund_tax: "7.77",
	},
	return_line_items: [
		{
			order_line_item_id: "577620148778013424",
			return_line_item_id: "4035352486720803568",
			sku_id: "1731937225762182074",
			seller_sku: "TT-CF25TT",
		},
	],
};
const parent = {
	id: "4035352489823474416",
	status: "PENDING_REQUEST_REVIEW",
	sku_return_requests: [sku],
};
const api = vi.mocked(tiktokApi);

beforeEach(() => api.mockReset());

test("new aftersales pagination preserves legacy ids, forward lines, total and records", async () => {
	api
		.mockResolvedValueOnce({
			aftersales_requests: [parent],
			next_page_token: "page-2",
		})
		.mockResolvedValueOnce({ aftersales_requests: [] })
		.mockResolvedValueOnce({ return_merchandise_authorizations: [] })
		.mockResolvedValueOnce({
			records: [{ role: "BUYER", note: " Handle missing " }],
		});
	const raw = await fetchTiktokReturns(from, until);
	expect(api).toHaveBeenCalledTimes(3);
	const { returns: found } = await withBuyerNotes(
		raw,
		new Set(raw.map((row) => row.externalId)),
	);
	expect(api.mock.calls[0]).toEqual([
		"/return_refund/202603/aftersales/search",
		{ shop_cipher: "cipher" },
		{
			filters: {
				time: {
					update_time: {
						min_unix_time_inclusive: from.getTime() / 1000,
						max_unix_time_exclusive: until.getTime() / 1000,
					},
				},
			},
			pagination: { page_size: 50 },
			whitelisted_data_fields: ["LINE_ITEMS", "SKU_RETURN_REQUESTS"],
		},
	]);
	expect(api.mock.calls[1]?.[2]).toMatchObject({
		pagination: { page_token: "page-2" },
	});
	expect(api.mock.calls[2]?.[2]).toMatchObject({
		filters: { aftersales_request_ids: [parent.id] },
	});
	expect(api.mock.calls[3]?.[0]).toBe(
		`/return_refund/202309/returns/${sku.return_id}/records`,
	);
	expect(found).toMatchObject([
		{
			externalId: sku.return_id,
			caseRef: parent.id,
			status: "requested",
			waitingOn: "us",
			respondBy: new Date("2026-10-26T17:54:39Z"),
			amount: "101.77",
			currency: "USD",
			note: "Handle missing",
			updatedAt: new Date(1792800000000),
			lines: [
				{ lineExternalId: "577620148778013424", sku: "TT-CF25TT", quantity: 1 },
			],
		},
	]);
});

test("history uses the newer create_time filter, never legacy query pagination", async () => {
	api.mockResolvedValueOnce({ aftersales_requests: [] });
	await fetchTiktokReturns(from, until, "create");
	expect(api.mock.calls[0]?.[2]).toMatchObject({
		filters: {
			time: { create_time: { min_unix_time_inclusive: from.getTime() / 1000 } },
		},
	});
});

test.each([
	{ aftersales_request_id: "unrelated-parent", sku_return_requests: [sku] },
	{
		aftersales_request_id: parent.id,
		sku_return_requests: [{ ...sku, order_id: "another-order" }],
	},
])("unrelated RMAs fail closed rather than changing ownership: %o", async (extra) => {
	api
		.mockResolvedValueOnce({ aftersales_requests: [parent] })
		.mockResolvedValueOnce({
			return_merchandise_authorizations: [
				{ id: "rma", status: "PENDING_PACKAGE_REVIEW", ...extra },
			],
		});
	await expect(fetchTiktokReturns(from, until)).rejects.toThrow(
		/TikTok RMA rma/,
	);
});

test.each([
	"package",
	"sku",
])("RMA-only %s review and tracking attach only to their SKU request", async (actionLocation) => {
	const physical = {
		...sku,
		return_type: "RETURN_AND_REFUND",
		return_status: "BUYER_SHIPPED_ITEM",
		seller_next_action_response: [],
	};
	api
		.mockResolvedValueOnce({
			aftersales_requests: [
				{
					...parent,
					status: "REQUEST_REVIEW_COMPLETED",
					sku_return_requests: [physical],
				},
			],
		})
		.mockResolvedValueOnce({
			return_merchandise_authorizations: [
				{
					id: "rma",
					aftersales_request_id: parent.id,
					status: "PENDING_PACKAGE_REVIEW",
					seller_next_action_response:
						actionLocation === "package"
							? [{ action: "REVIEW_PACKAGE", deadline: 1793164840 }]
							: [],
					sku_return_requests: [
						{
							...physical,
							seller_next_action_response:
								actionLocation === "sku"
									? [{ action: "REVIEW_PACKAGE", deadline: 1793164840 }]
									: [],
							refund_amount: { refund_total: "999.99", currency: "USD" },
							return_tracking_number: "tracking",
							return_provider_name: "UPS",
						},
					],
				},
			],
		})
		.mockResolvedValueOnce({ records: [] });
	expect(await fetchTiktokReturns(from, until)).toMatchObject([
		{
			status: "delivered",
			waitingOn: "us",
			respondBy: new Date("2026-10-28T05:20:40Z"),
			nextAction: "REVIEW_PACKAGE",
			amount: "101.77",
			trackingNumber: "tracking",
			carrier: "UPS",
		},
	]);
});

test("failed notes do not erase a saved note and unknown statuses remain reportable", async () => {
	api
		.mockResolvedValueOnce({
			aftersales_requests: [
				{
					...parent,
					sku_return_requests: [
						{
							...sku,
							return_status: "FUTURE_STATUS",
							seller_next_action_response: [],
						},
					],
				},
			],
		})
		.mockResolvedValueOnce({})
		.mockRejectedValueOnce(new Error("unavailable"));
	const raw = await fetchTiktokReturns(from, until);
	const result = await withBuyerNotes(
		raw,
		new Set(raw.map((row) => row.externalId)),
	);
	expect(result.returns).toMatchObject([
		{
			status: "unknown",
			waitingOn: "marketplace",
			note: undefined,
			noteUnread: true,
			problems: ["Unknown TikTok return status: FUTURE_STATUS"],
		},
	]);
	expect(result.problems).toEqual([
		`TikTok return ${sku.return_id} note: unavailable; asked again next pass`,
	]);
});

test.each([
	"aftersales",
	"RMA",
])("truncated %s search cannot count as a complete read", async (source) => {
	api.mockResolvedValueOnce({
		aftersales_requests: [parent],
		total_count: source === "aftersales" ? 2 : 1,
	});
	if (source === "RMA")
		api.mockResolvedValueOnce({
			return_merchandise_authorizations: [],
			total_count: 1,
		});
	await expect(fetchTiktokReturns(from, until)).rejects.toThrow(
		/TikTok .*truncated/,
	);
});

test("repeated pagination cannot loop forever or verify a partial read", async () => {
	api
		.mockResolvedValueOnce({
			aftersales_requests: [parent],
			next_page_token: "same",
		})
		.mockResolvedValueOnce({
			aftersales_requests: [],
			next_page_token: "same",
		});
	await expect(fetchTiktokReturns(from, until)).rejects.toThrow(
		"repeated its page token",
	);
});
