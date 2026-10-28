import { type } from "arktype";
import type { ChannelReturn } from "#/orders/return-requests";
import { shopCipher, tiktokApi } from "./tiktok";
import { tiktokReturnStage } from "./tiktok-case-stage";
import { TiktokReturnPages } from "./tiktok-return-pages";

export { tiktokReturnStage } from "./tiktok-case-stage";

// Returns buyers opened on TikTok Shop, with TikTok's reason. What the
// buyer wrote and showed is in the return's records (tiktok-return-records.ts). Needs the Return & Refund Basic
// permission (seller.return_refund.basic), granted when the shop authorizes
// the app. Orders Shopify relayed are TikTok's too, so they're found by
// their TikTok order id wherever they live.

const SEARCH = "/return_refund/202603/aftersales/search";
const RMA_SEARCH = "/return_refund/202604/rma/search";

const returnOrder = type({
	return_id: "string",
	order_id: "string",
	return_status: "string",
	"return_type?": "string",
	"arbitration_status?": "string",
	"seller_next_action_response?": type({
		action: "string",
		"deadline?": "number.integer >= 0",
	}).array(),
	"refund_amount?": { currency: /^[A-Z]{3}$/, refund_total: "string.numeric" },
	create_time: "number.integer",
	"update_time?": "number.integer",
	"return_reason?": "string",
	"return_reason_text?": "string",
	"return_tracking_number?": "string",
	"return_provider_name?": "string",
	"return_line_items?": type({
		"sku_id?": "string",
		"seller_sku?": "string",
		"order_line_item_id?": "string",
	}).array(),
});
export type TiktokReturn = typeof returnOrder.infer;
const aftersales = type({
	id: "string",
	status: "string",
	sku_return_requests: returnOrder.array(),
});
const searchPage = type({
	"aftersales_requests?": aftersales.array(),
	"total_count?": "number.integer >= 0",
	"next_page_token?": "string",
});
const rma = type({
	id: "string",
	aftersales_request_id: "string",
	status: "string",
	"seller_next_action_response?": type({
		action: "string",
		"deadline?": "number.integer >= 0",
	}).array(),
	sku_return_requests: returnOrder.array(),
});
const rmaPage = type({
	"return_merchandise_authorizations?": rma.array(),
	"total_count?": "number.integer >= 0",
	"next_page_token?": "string",
});
// TikTok refunds a creator's free sample ("buy now, refund later") through
// returns too, with nothing wrong and nothing coming back. Not a return.
export const isSampleRefund = (r: { return_reason?: string }) =>
	r.return_reason?.startsWith("system_refund_sample") ?? false;

// Forward line IDs keep distinct lines apart. Older order imports still
// use SKU IDs, so matching accepts that namespace too.
export function tiktokToReturn(
	r: TiktokReturn,
	note?: string | null,
	parent?: {
		id: string;
		status: string;
		rmaStatus?: string;
		packageReviewActions?: { action: string; deadline?: number }[];
	},
): ChannelReturn {
	const byLine = new Map<
		string,
		{ sku: string | null; skuId: string | null; quantity: number }
	>();
	for (const line of r.return_line_items ?? []) {
		const key = line.order_line_item_id ?? line.sku_id ?? line.seller_sku ?? "";
		const seen = byLine.get(key);
		byLine.set(key, {
			sku: line.seller_sku ?? null,
			skuId: line.sku_id ?? null,
			quantity: (seen?.quantity ?? 0) + 1,
		});
	}
	return {
		externalId: r.return_id,
		orderExternalId: r.order_id,
		marketplaceOrderId: `tiktok:${r.order_id}`,
		...tiktokReturnStage({
			...r,
			afterSalesStatus: parent?.status,
			rmaStatus: parent?.rmaStatus,
			packageReviewActions: parent?.packageReviewActions,
		}),
		...(r.refund_amount
			? {
					amount: r.refund_amount.refund_total,
					currency: r.refund_amount.currency,
				}
			: { amount: null, currency: null }),
		caseRef: parent?.id ?? null,
		rawStatus: r.return_status,
		reason: r.return_reason_text || r.return_reason || null,
		note,
		trackingNumber: r.return_tracking_number || null,
		carrier: r.return_provider_name || null,
		requestedAt: new Date(r.create_time * 1000),
		// TikTok's version of it; without one it's unversioned, never the
		// time it was opened, so it can't pass for news.
		...(r.update_time === undefined
			? {}
			: { updatedAt: new Date(r.update_time * 1000) }),
		lines: [...byLine].map(([lineId, line]) => ({
			lineExternalId: lineId || null,
			alternateLineExternalId: line.skuId,
			sku: line.sku,
			quantity: line.quantity,
		})),
	};
}

// Returns that changed between from and until (by: "update"), or were
// opened then (by: "create", for history), without their records: those
// cost a request each (tiktok-return-records.ts).
export async function fetchTiktokReturns(
	from: Date,
	until: Date,
	by: "create" | "update" = "update",
) {
	const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
	const { returns } = await readCases({
		time: {
			[`${by}_time`]: {
				min_unix_time_inclusive: seconds(from),
				max_unix_time_exclusive: seconds(until),
			},
		},
	});
	return returns;
}

// What a webhook names, read again by id: one aftersales case, or every
// case on an order. found counts the cases TikTok had, so a case it doesn't
// show yet isn't mistaken for one with nothing to save.
export type CaseLookup =
	| { kind: "aftersales"; id: string }
	| { kind: "order_returns"; id: string };

export function fetchTiktokCases(lookup: CaseLookup) {
	switch (lookup.kind) {
		case "aftersales":
			return readCases({ aftersales_request_ids: [lookup.id] });
		case "order_returns":
			return readCases({ main_order_ids: [lookup.id] });
	}
}

async function readCases(filters: Record<string, unknown>) {
	const cipher = await shopCipher();
	const found: (typeof aftersales.infer)[] = [];
	const pages = new TiktokReturnPages("aftersales search");
	let pageToken: string | undefined;
	do {
		const page = searchPage.assert(
			await tiktokApi(
				SEARCH,
				{
					shop_cipher: cipher,
				},
				{
					filters,
					pagination: {
						page_size: 50,
						...(pageToken ? { page_token: pageToken } : {}),
					},
					whitelisted_data_fields: ["LINE_ITEMS", "SKU_RETURN_REQUESTS"],
				},
			),
		);
		found.push(...(page.aftersales_requests ?? []));
		pageToken = pages.read(page.aftersales_requests ?? [], page);
	} while (pageToken);
	const packages = new Map<string, typeof rma.infer>();
	for (const parent of found) {
		if (parent.sku_return_requests.length === 0)
			throw new Error(`TikTok aftersales ${parent.id} has no SKU requests`);
		const packagePages = new TiktokReturnPages(`RMA search for ${parent.id}`);
		let token: string | undefined;
		do {
			const page = rmaPage.assert(
				await tiktokApi(
					RMA_SEARCH,
					{ shop_cipher: cipher },
					{
						filters: { aftersales_request_ids: [parent.id] },
						pagination: {
							page_size: 50,
							...(token ? { page_token: token } : {}),
						},
						whitelisted_data_fields: ["SKU_RETURN_REQUESTS"],
					},
				),
			);
			for (const pkg of page.return_merchandise_authorizations ?? []) {
				if (pkg.aftersales_request_id !== parent.id)
					throw new Error(
						`TikTok RMA ${pkg.id} belongs to another aftersales request`,
					);
				if (pkg.sku_return_requests.length === 0)
					throw new Error(`TikTok RMA ${pkg.id} has no SKU requests`);
				for (const request of pkg.sku_return_requests ?? []) {
					if (
						!parent.sku_return_requests.some(
							(sku) =>
								sku.return_id === request.return_id &&
								sku.order_id === request.order_id,
						)
					)
						throw new Error(
							`TikTok RMA ${pkg.id} has an unrelated SKU request`,
						);
					if (packages.has(request.return_id))
						throw new Error(
							`TikTok return ${request.return_id} has multiple RMAs`,
						);
					packages.set(request.return_id, pkg);
				}
			}
			token = packagePages.read(
				page.return_merchandise_authorizations ?? [],
				page,
			);
		} while (token);
	}
	const requests = found.flatMap((parent) =>
		parent.sku_return_requests
			.filter((request) => !isSampleRefund(request))
			.map((request) => ({ parent, request })),
	);
	const returns = requests.map(({ parent, request }) => {
		const pkg = packages.get(request.return_id);
		const shipped = pkg?.sku_return_requests?.find(
			(sku) => sku.return_id === request.return_id,
		);
		return tiktokToReturn(
			{
				...request,
				return_tracking_number:
					shipped?.return_tracking_number ?? request.return_tracking_number,
				return_provider_name:
					shipped?.return_provider_name ?? request.return_provider_name,
			},
			undefined,
			{
				...parent,
				rmaStatus: pkg?.status,
				packageReviewActions: [
					...(pkg?.seller_next_action_response ?? []),
					...(shipped?.seller_next_action_response ?? []),
				],
			},
		);
	});
	return { returns, found: found.length };
}
