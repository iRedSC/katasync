import { type } from "arktype";
import { errorText } from "#/diagnostics/runs";
import type { ChannelReturn } from "#/orders/return-requests";
import { shopCipher, tiktokApi } from "./tiktok";
import { tiktokReturnStage } from "./tiktok-case-stage";

export { tiktokReturnStage } from "./tiktok-case-stage";

// Returns buyers opened on TikTok Shop, with TikTok's reason, and what the
// buyer wrote from the return's records. Needs the Return & Refund Basic
// permission (seller.return_refund.basic), granted when the shop authorizes
// the app. Orders Shopify relayed are TikTok's too, so they're found by
// their TikTok order id wherever they live.

const SEARCH = "/return_refund/202603/aftersales/search";
const RMA_SEARCH = "/return_refund/202604/rma/search";
const records = (id: string) => `/return_refund/202309/returns/${id}/records`;

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
	"next_page_token?": "string",
});
const rma = type({
	id: "string",
	aftersales_request_id: "string",
	status: "string",
	sku_return_requests: returnOrder.array(),
});
const rmaPage = type({
	"return_merchandise_authorizations?": rma.array(),
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

// Forward line IDs keep distinct lines apart. Older order imports still
// use SKU IDs, so matching accepts that namespace too.
export function tiktokToReturn(
	r: TiktokReturn,
	note?: string | null,
	parent?: { id: string; status: string; rmaStatus?: string },
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
		}),
		...(r.refund_amount
			? {
					amount: r.refund_amount.refund_total,
					currency: r.refund_amount.currency,
				}
			: { amount: null, currency: null }),
		caseRef: parent?.id ?? null,
		nextAction:
			r.seller_next_action_response
				?.map((action) => action.action)
				.join(", ") || null,
		rawStatus: r.return_status,
		reason: r.return_reason_text || r.return_reason || null,
		note,
		trackingNumber: r.return_tracking_number || null,
		carrier: r.return_provider_name || null,
		requestedAt: new Date(r.create_time * 1000),
		lines: [...byLine].map(([lineId, line]) => ({
			lineExternalId: lineId || null,
			alternateLineExternalId: line.skuId,
			sku: line.sku,
			quantity: line.quantity,
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
	const found: (typeof aftersales.infer)[] = [];
	let pageToken: string | undefined;
	do {
		const page = searchPage.assert(
			await tiktokApi(
				SEARCH,
				{
					shop_cipher: cipher,
				},
				{
					filters: {
						time: {
							[`${by}_time`]: {
								min_unix_time_inclusive: seconds(from),
								max_unix_time_exclusive: seconds(until),
							},
						},
					},
					pagination: {
						page_size: 50,
						...(pageToken ? { page_token: pageToken } : {}),
					},
					whitelisted_data_fields: ["LINE_ITEMS", "SKU_RETURN_REQUESTS"],
				},
			),
		);
		found.push(...(page.aftersales_requests ?? []));
		pageToken = page.next_page_token || undefined;
	} while (pageToken);
	const packages = new Map<string, typeof rma.infer>();
	for (const parent of found) {
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
			token = page.next_page_token || undefined;
		} while (token);
	}
	const requests = found.flatMap((parent) =>
		parent.sku_return_requests
			.filter((request) => !isSampleRefund(request))
			.map((request) => ({ parent, request })),
	);
	const notes = await buyerNotes(
		cipher,
		requests.map(({ request }) => request.return_id),
	);
	return requests.map(({ parent, request }) => {
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
			notes.get(request.return_id),
			{ ...parent, rmaStatus: pkg?.status },
		);
	});
}
