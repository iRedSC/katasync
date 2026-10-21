import { type } from "arktype";
import { shopifyQuery } from "#/channels/shopify/client";
import type { FetchedPayout } from "./types";

// Shopify Payments payouts. Reading them needs the app's
// read_shopify_payments_payouts scope; without it Shopify refuses and the
// Reports tab says so.

export const shopifyPayout = type({
	id: "string",
	issuedAt: "string.date.iso.parse",
	status: "string",
	net: { amount: "string.numeric.parse", currencyCode: "string" },
});
const page = type({
	shopifyPaymentsAccount: type({
		payouts: {
			pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
			nodes: shopifyPayout.array(),
		},
	}).or("null"),
});

const QUERY = `query Payouts($cursor: String, $query: String) {
	shopifyPaymentsAccount {
		payouts(first: 100, after: $cursor, query: $query) {
			pageInfo { hasNextPage endCursor }
			nodes { id issuedAt status net { amount currencyCode } }
		}
	}
}`;

// SCHEDULED and IN_TRANSIT are on their way; CANCELED never went.
export function shopifyToPayout(
	p: typeof shopifyPayout.infer,
): FetchedPayout | null {
	if (p.status === "CANCELED") return null;
	return {
		externalId: p.id,
		status:
			p.status === "PAID"
				? "sent"
				: p.status === "FAILED"
					? "failed"
					: "pending",
		depositedAt: p.issuedAt,
		amount: p.net.amount,
		currency: p.net.currencyCode,
		bankTail: null,
		reference: null,
	};
}

export async function fetchShopifyPayouts(since: Date) {
	const found: FetchedPayout[] = [];
	let cursor: string | null | undefined = null;
	do {
		const data = page.assert(
			await shopifyQuery(QUERY, {
				cursor,
				query: `issued_at:>=${since.toISOString().slice(0, 10)}`,
			}),
		);
		const payouts = data.shopifyPaymentsAccount?.payouts;
		if (!payouts) return found;
		for (const p of payouts.nodes) {
			const payout = shopifyToPayout(p);
			if (payout) found.push(payout);
		}
		cursor = payouts.pageInfo.hasNextPage ? payouts.pageInfo.endCursor : null;
	} while (cursor);
	return found;
}
