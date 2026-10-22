import { type } from "arktype";
import type { ChannelReturn } from "#/orders/return-requests";
import { accessToken } from "./ebay";

// Returns buyers opened on eBay, with eBay's reason and what the buyer
// wrote, from the Post-Order API. It takes the same user token as the rest
// of eBay, sent as IAF rather than Bearer. It can't look back further than
// 18 months.

const SEARCH = "https://api.ebay.com/post-order/v2/return/search";
const PAGE = 200;
const DAY = 24 * 60 * 60 * 1000;
export const HISTORY_DAYS = 540;
// Regular passes read this far back by creation date. Older windows are as wide.
export const DISCOVERY_DAYS = 60;
const WINDOW = DISCOVERY_DAYS * DAY;

const member = type({
	returnId: "string",
	orderId: "string",
	state: "string",
	creationInfo: {
		"reason?": "string",
		"comments?": type({ "content?": "string" }).or("null"),
		item: {
			"itemId?": "string",
			"transactionId?": "string",
			"returnQuantity?": "number.integer",
		},
		creationDate: { value: "string.date.iso.parse" },
	},
});
export type EbayReturn = typeof member.infer;
const page = type({
	"members?": member.array(),
	"paginationOutput?": { "totalPages?": "number.integer" },
});

// eBay's states, as a stage.
export function ebayReturnStatus(state: string): ChannelReturn["status"] {
	if (state.includes("CANCEL")) return "cancelled";
	if (state.includes("CLOSED")) return "closed";
	if (state === "ITEM_DELIVERED") return "delivered";
	if (state === "ITEM_SHIPPED") return "shipped";
	return "requested";
}

// An eBay return is one item. Its transaction id is the line's id
// (Fulfillment's lineItemId), which order_lines keeps.
export function ebayToReturn(m: EbayReturn): ChannelReturn {
	const item = m.creationInfo.item;
	return {
		externalId: m.returnId,
		orderExternalId: m.orderId,
		status: ebayReturnStatus(m.state),
		rawStatus: m.state,
		reason: m.creationInfo.reason ?? null,
		note: m.creationInfo.comments?.content?.trim() || null,
		trackingNumber: null,
		carrier: null,
		requestedAt: m.creationInfo.creationDate.value,
		lines: [
			{
				lineExternalId: item.transactionId ?? null,
				sku: null,
				quantity: item.returnQuantity ?? 1,
			},
		],
	};
}

// Returns opened between from and until. eBay's offset is a page number,
// counting from 1 (0 reads as 1, so counting from 0 repeats the first page).
export async function fetchEbayReturns(from: Date, until: Date) {
	const returns: ChannelReturn[] = [];
	for (let offset = 1; ; offset++) {
		const params = new URLSearchParams({
			role: "SELLER",
			creation_date_range_from: from.toISOString(),
			creation_date_range_to: until.toISOString(),
			limit: String(PAGE),
			offset: String(offset),
		});
		const response = await fetch(`${SEARCH}?${params}`, {
			headers: {
				Authorization: `IAF ${await accessToken()}`,
				"X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
				"Content-Type": "application/json",
			},
		});
		if (!response.ok)
			throw new Error(
				`eBay answered ${response.status} on returns: ${await response.text()}`,
			);
		const found = page.assert(await response.json());
		const members = found.members ?? [];
		returns.push(...members.map(ebayToReturn));
		if (
			members.length < PAGE ||
			offset >= (found.paginationOutput?.totalPages ?? offset)
		)
			return returns;
	}
}

// Open returns older than discovery reaches. eBay searches by creation date,
// so each older window that holds one is read again, keeping only the returns
// still open here: a closure eBay made since then comes through.
export async function fetchOlderOpenReturns(
	open: { externalId: string; requestedAt: Date }[],
	now: Date,
): Promise<ChannelReturn[]> {
	const wanted = new Set(open.map((o) => o.externalId));
	const windows = new Set<number>();
	for (const o of open) {
		const age = now.getTime() - o.requestedAt.getTime();
		const back = Math.floor(age / WINDOW);
		if (back >= 1 && age < HISTORY_DAYS * DAY) windows.add(back);
	}
	const returns: ChannelReturn[] = [];
	for (const back of windows) {
		const until = new Date(now.getTime() - back * WINDOW);
		const from = new Date(until.getTime() - WINDOW);
		const found = await fetchEbayReturns(from, until);
		returns.push(...found.filter((r) => wanted.has(r.externalId)));
	}
	return returns;
}
