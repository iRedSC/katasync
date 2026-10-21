import { type } from "arktype";
import { shopifyRest } from "#/channels/shopify/client";
import type { FetchedPayout } from "./types";

// Shopify Payments payouts, from the REST API: GraphQL only reaches them
// through the payments account, which needs more access than the app's
// read_shopify_payments_payouts scope.

export const shopifyPayout = type({
	id: "number",
	status: "string",
	date: "string",
	amount: "string.numeric.parse",
	currency: "string",
});
const page = type({ payouts: shopifyPayout.array() });

// scheduled and in_transit are on their way; canceled never went.
export function shopifyToPayout(
	p: typeof shopifyPayout.infer,
): FetchedPayout | null {
	if (p.status === "canceled") return null;
	return {
		externalId: String(p.id),
		status:
			p.status === "paid"
				? "sent"
				: p.status === "failed"
					? "failed"
					: "pending",
		// The day it's sent, as Shopify dates it: noon, so no time zone moves it
		// to the day before.
		depositedAt: new Date(`${p.date}T12:00:00Z`),
		amount: p.amount,
		currency: p.currency,
		bankTail: null,
		reference: null,
	};
}

export async function fetchShopifyPayouts(since: Date) {
	const found: FetchedPayout[] = [];
	let path: string | null =
		`shopify_payments/payouts.json?limit=250&date_min=${since.toISOString().slice(0, 10)}`;
	while (path) {
		const { body, next }: { body: unknown; next: string | null } =
			await shopifyRest(path);
		for (const p of page.assert(body).payouts) {
			const payout = shopifyToPayout(p);
			if (payout) found.push(payout);
		}
		path = next;
	}
	return found;
}
