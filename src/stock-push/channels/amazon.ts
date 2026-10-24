import { type } from "arktype";
import { MARKETPLACE_US, spApi } from "#/channels/amazon-api";
import type { Found, StockChannel } from "../channel";

const LISTINGS = "/listings/2021-08-01/items";

const target = type({
	productType: "string",
	// The DEFAULT fulfillment_availability entry, quantity aside.
	availability: "Record<string, unknown>",
});
type Target = typeof target.infer;

function sellerId() {
	const id = process.env.AMAZON_SELLER_ID;
	if (!id)
		throw new Error(
			"Set AMAZON_SELLER_ID to the merchant token in Seller Central (Settings, Account Info, Merchant Token)",
		);
	return id;
}

const item = type({
	sku: "string",
	"summaries?": type({
		marketplaceId: "string",
		"productType?": "string",
	}).array(),
	"attributes?": {
		"fulfillment_availability?": type({
			fulfillment_channel_code: "string",
			"+": "ignore",
		}).array(),
		"+": "ignore",
	},
	"fulfillmentAvailability?": type({
		fulfillmentChannelCode: "string",
		"quantity?": "number.integer",
	}).array(),
});

const searchPage = type({
	"items?": item.array(),
	"pagination?": { "nextToken?": "string" },
});

// One listing as a stock read sees it, or null for one Amazon ships.
export function amazonStockFound(
	listing: typeof item.infer,
): Found<Target> | null {
	const shown = listing.fulfillmentAvailability ?? [];
	const ours = shown.find((f) => f.fulfillmentChannelCode === "DEFAULT");
	if (!ours) {
		if (shown.length > 0) return null;
		return {
			state: "unpushable",
			reason: "Amazon shows no offer we ship for it",
		};
	}
	const entry = listing.attributes?.fulfillment_availability?.find(
		(f) => f.fulfillment_channel_code === "DEFAULT",
	) ?? { fulfillment_channel_code: "DEFAULT" };
	const { quantity: _, ...availability } = entry as Record<string, unknown>;
	const productType =
		listing.summaries?.find((s) => s.marketplaceId === MARKETPLACE_US)
			?.productType ?? "PRODUCT";
	return {
		state: "ready",
		target: { productType, availability },
		shows: ours.quantity ?? null,
	};
}

async function read() {
	const seller = encodeURIComponent(sellerId());
	const found = new Map<string, Found<Target>>();
	let pageToken: string | undefined;
	do {
		const query = new URLSearchParams({
			marketplaceIds: MARKETPLACE_US,
			includedData: "summaries,attributes,fulfillmentAvailability",
			pageSize: "20",
			...(pageToken ? { pageToken } : {}),
		});
		const page = searchPage.assert(
			await spApi(`${LISTINGS}/${seller}?${query}`),
		);
		for (const listing of page.items ?? []) {
			const f = amazonStockFound(listing);
			if (f) found.set(listing.sku, f);
		}
		pageToken = page.pagination?.nextToken;
	} while (pageToken);
	return found;
}

export const amazonStock: StockChannel<Target> = {
	name: "Amazon",
	target,
	read,
};
