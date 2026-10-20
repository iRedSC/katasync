import { type } from "arktype";
import { MARKETPLACE_US, spApi } from "./amazon-api";
import { API, accessToken } from "./ebay";

// Whether a channel without order webhooks has had an order placed or changed
// since `since`, asked of the channel alone: the database stays asleep unless
// the answer is yes (src/routes/api/cron/orders.$channel.ts).

const amazonPage = type({ payload: { Orders: "unknown[]" } });
const ebayPage = type({ total: "number" });

export async function hasNewOrders(
	channel: "amazon" | "ebay",
	since: Date,
): Promise<boolean> {
	if (channel === "amazon") {
		// Only the orders we ship: Amazon's own (FBA) take none of our stock.
		const page = amazonPage.assert(
			await spApi(
				`/orders/v0/orders?MarketplaceIds=${MARKETPLACE_US}&FulfillmentChannels=MFN&LastUpdatedAfter=${since.toISOString()}&MaxResultsPerPage=1`,
			),
		);
		return page.payload.Orders.length > 0;
	}
	const response = await fetch(
		`${API}/sell/fulfillment/v1/order?limit=1&filter=${encodeURIComponent(`lastmodifieddate:[${since.toISOString()}..]`)}`,
		{ headers: { Authorization: `Bearer ${await accessToken()}` } },
	);
	if (!response.ok)
		throw new Error(
			`eBay answered ${response.status}: ${await response.text()}`,
		);
	return ebayPage.assert(await response.json()).total > 0;
}
