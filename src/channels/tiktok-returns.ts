import { type } from "arktype";
import { errorText } from "#/diagnostics/runs";
import type { ChannelReturn, RequestStage } from "#/orders/return-requests";
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
// type REFUND) waits on our answer while it's pending, then is refunded
// (closed) or turned down (cancelled); it never ships.
export function tiktokReturnStage(r: {
	return_status: string;
	return_type?: string;
}): RequestStage {
	const s = r.return_status;
	const ended = s.includes("CANCEL") || s.includes("REJECT");
	const settled = s.includes("COMPLETE") || s.includes("SUCCESS");
	if (r.return_type === "REFUND")
		return {
			kind: "refund",
			status: ended ? "cancelled" : settled ? "closed" : "requested",
		};
	if (ended) return { kind: "return", status: "cancelled" };
	if (settled) return { kind: "return", status: "closed" };
	if (s === "BUYER_SHIPPED_ITEM") return { kind: "return", status: "shipped" };
	return { kind: "return", status: "requested" };
}

// TikTok lists each unit as its own line; order_lines keeps one per SKU id,
// so units of the same SKU add up.
export function tiktokToReturn(
	r: TiktokReturn,
	note?: string | null,
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
		...tiktokReturnStage(r),
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

// One history request per return, a few at a time. A note that fails to load
// is left out of the map: its return still saves, without touching its note.
const NOTE_REQUESTS_AT_ONCE = 4;

async function buyerNotes(cipher: string, returnIds: string[]) {
	const notes = new Map<string, string | null>();
	const queue = [...returnIds];
	const worker = async () => {
		for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
			try {
				notes.set(id, await buyerNote(cipher, id));
			} catch (error) {
				console.warn(`TikTok return ${id} note: ${errorText(error)}`);
			}
		}
	};
	await Promise.all(Array.from({ length: NOTE_REQUESTS_AT_ONCE }, worker));
	return notes;
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
	const found: TiktokReturn[] = [];
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
			if (!isSampleRefund(r)) found.push(r);
		pageToken = page.next_page_token || undefined;
	} while (pageToken);
	const notes = await buyerNotes(
		cipher,
		found.map((r) => r.return_id),
	);
	return found.map((r) => tiktokToReturn(r, notes.get(r.return_id)));
}
