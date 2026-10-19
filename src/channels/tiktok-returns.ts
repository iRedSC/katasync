import { type } from "arktype";
import type { ChannelReturn } from "#/orders/return-requests";
import { shopCipher, tiktokApi } from "./tiktok";

// Returns buyers opened on TikTok Shop, with TikTok's reason, and what the
// buyer wrote from the return's records. Needs the Return & Refund Basic
// permission (seller.return_refund.basic), granted when the shop authorizes
// the app. Orders Shopify relayed are TikTok's too, so they're found by
// their TikTok order id wherever they live.

const SEARCH = "/return_refund/202309/returns/search";
const records = (id: string) => `/return_refund/202309/returns/${id}/records`;

const returnOrder = type({
	return_id: "string",
	order_id: "string",
	return_status: "string",
	"return_type?": "string",
	create_time: "number.integer",
	"return_reason?": "string",
	"return_reason_text?": "string",
	"return_tracking_number?": "string",
	"return_provider_name?": "string",
	"return_line_items?": type({
		"sku_id?": "string",
		"seller_sku?": "string",
	}).array(),
});
export type TiktokReturn = typeof returnOrder.infer;
const searchPage = type({
	"return_orders?": returnOrder.array(),
	"next_page_token?": "string",
});
const recordList = type({
	"records?": type({
		"role?": "string",
		"note?": "string",
	}).array(),
});

// TikTok refunds a creator's free sample ("buy now, refund later") through
// returns too, with nothing wrong and nothing coming back. Not a return.
export const isSampleRefund = (r: { return_reason?: string }) =>
	r.return_reason?.startsWith("system_refund_sample") ?? false;

// TikTok's statuses, as a stage. A refund with nothing coming back (return
// type REFUND) is closed: it still counts as returned in the rates, but
// nothing is due back.
export function tiktokReturnStatus(r: {
	return_status: string;
	return_type?: string;
}): ChannelReturn["status"] {
	const s = r.return_status;
	if (s.includes("CANCEL") || s.includes("REJECT")) return "cancelled";
	if (r.return_type === "REFUND") return "closed";
	if (s.includes("COMPLETE") || s.includes("SUCCESS")) return "closed";
	if (s === "BUYER_SHIPPED_ITEM") return "shipped";
	return "requested";
}

// TikTok lists each unit as its own line; order_lines keeps one per SKU id,
// so units of the same SKU add up.
export function tiktokToReturn(
	r: TiktokReturn,
	note: string | null,
): ChannelReturn {
	const bySku = new Map<string, { sku: string | null; quantity: number }>();
	for (const l of r.return_line_items ?? []) {
		const key = l.sku_id ?? l.seller_sku ?? "";
		const seen = bySku.get(key);
		bySku.set(key, {
			sku: l.seller_sku ?? null,
			quantity: (seen?.quantity ?? 0) + 1,
		});
	}
	return {
		externalId: r.return_id,
		orderExternalId: r.order_id,
		marketplaceOrderId: `tiktok:${r.order_id}`,
		status: tiktokReturnStatus(r),
		rawStatus: r.return_status,
		reason: r.return_reason_text || r.return_reason || null,
		note,
		trackingNumber: r.return_tracking_number || null,
		carrier: r.return_provider_name || null,
		requestedAt: new Date(r.create_time * 1000),
		lines: [...bySku].map(([skuId, l]) => ({
			lineExternalId: skuId || null,
			sku: l.sku,
			quantity: l.quantity,
		})),
	};
}

// What the buyer wrote when asking: the first note of theirs in the
// return's history.
async function buyerNote(cipher: string, returnId: string) {
	const found = recordList.assert(
		await tiktokApi(records(returnId), { shop_cipher: cipher }),
	);
	const note = found.records?.find(
		(r) => r.role === "BUYER" && r.note?.trim(),
	)?.note;
	return note?.trim() || null;
}

// Returns that changed between from and until (by: "update"), or were
// opened then (by: "create", for history).
export async function fetchTiktokReturns(
	from: Date,
	until: Date,
	by: "create" | "update" = "update",
) {
	const cipher = await shopCipher();
	const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
	const returns: ChannelReturn[] = [];
	let pageToken: string | undefined;
	do {
		const page = searchPage.assert(
			await tiktokApi(
				SEARCH,
				{
					shop_cipher: cipher,
					page_size: "50",
					...(pageToken ? { page_token: pageToken } : {}),
				},
				{
					[`${by}_time_ge`]: seconds(from),
					[`${by}_time_lt`]: seconds(until),
				},
			),
		);
		for (const r of page.return_orders ?? [])
			if (!isSampleRefund(r))
				returns.push(tiktokToReturn(r, await buyerNote(cipher, r.return_id)));
		pageToken = page.next_page_token || undefined;
	} while (pageToken);
	return returns;
}
