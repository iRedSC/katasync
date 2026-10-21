import { type } from "arktype";
import { accessToken } from "#/channels/ebay";
import type { FetchedPayout } from "./types";

// eBay sends payouts from its Finances API, each with the bank's reference.

const PAYOUTS = "https://apiz.ebay.com/sell/finances/v1/payout";
const PAGE = 200;

export const ebayPayout = type({
	payoutId: "string",
	payoutStatus: "string",
	payoutDate: "string.date.iso.parse",
	amount: { value: "string.numeric.parse", currency: "string" },
	"payoutInstrument?": { "accountLastFourDigits?": "string" },
	"bankReference?": "string",
});
const page = type({ "payouts?": ebayPayout.array() });

// INITIATED and RETRYABLE_FAILED are still on their way; REVERSED came back.
export function ebayToPayout(p: typeof ebayPayout.infer): FetchedPayout {
	return {
		externalId: p.payoutId,
		status:
			p.payoutStatus === "SUCCEEDED"
				? "sent"
				: p.payoutStatus === "TERMINAL_FAILED" || p.payoutStatus === "REVERSED"
					? "failed"
					: "pending",
		depositedAt: p.payoutDate,
		amount: p.amount.value,
		currency: p.amount.currency,
		bankTail: p.payoutInstrument?.accountLastFourDigits ?? null,
		reference: p.bankReference ?? null,
	};
}

// eBay answers a long or open-ended payoutDate range with only part of it
// (one of 2025's months, or 2026's), so ask in closed 60-day windows. Even
// then it sometimes leaves payouts out of a window, or answers it with
// nothing at all, and has them the next time: each window is asked ASKS times
// and the answers put together. Payouts are never deleted, so one missed by
// every ask still arrives with a later pass.
const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const ASKS = 4;

export async function fetchEbayPayouts(since: Date) {
	const found = new Map<string, FetchedPayout>();
	for (let from = since.getTime(); from < Date.now(); from += WINDOW_MS) {
		const until = new Date(Math.min(from + WINDOW_MS, Date.now()));
		for (let ask = 0; ask < ASKS; ask++)
			for (const p of await ebayWindow(new Date(from), until))
				found.set(p.externalId, p);
	}
	return [...found.values()];
}

async function ebayWindow(from: Date, until: Date) {
	const found: FetchedPayout[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const url = new URL(PAYOUTS);
		url.search = new URLSearchParams({
			filter: `payoutDate:[${from.toISOString()}..${until.toISOString()}]`,
			limit: String(PAGE),
			offset: String(offset),
		}).toString();
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${await accessToken()}` },
		});
		if (!response.ok)
			throw new Error(
				`eBay payouts answered ${response.status}: ${await response.text()}`,
			);
		// A window with no payouts comes back empty (204), not as JSON.
		if (response.status === 204) return found;
		const payouts = page.assert(await response.json()).payouts ?? [];
		found.push(...payouts.map(ebayToPayout));
		if (payouts.length < PAGE) return found;
	}
}
