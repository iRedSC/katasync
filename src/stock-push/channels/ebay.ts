import { type } from "arktype";
import { XMLParser } from "fast-xml-parser";
import { API, accessToken } from "#/channels/ebay";
import type { Found, StockChannel } from "../channel";

const target = type({
	items: type({ itemId: "string", variationSku: "string | null" }).array(),
});
type Target = typeof target.infer;

const stockPage = type({
	GetMyeBaySellingResponse: {
		Ack: "string",
		"Errors?": type({ LongMessage: "string" }).array(),
		"ActiveList?": {
			"ItemArray?": {
				Item: type({
					ItemID: "string",
					"SKU?": "string",
					"QuantityAvailable?": "string.integer.parse",
					"Variations?": {
						Variation: type({
							"SKU?": "string",
							Quantity: "string.integer.parse",
							"SellingStatus?": { "QuantitySold?": "string.integer.parse" },
						}).array(),
					},
				}).array(),
			},
			PaginationResult: { TotalNumberOfPages: "string.integer.parse" },
		},
	},
});

const xml = new XMLParser({
	isArray: (name) => ["Item", "Variation", "Errors"].includes(name),
	parseTagValue: false,
});

type Place = {
	itemId: string;
	variationSku: string | null;
	shows: number | null;
};

// One page of active listings, as the places each listing's stock lives,
// added to `places`. Variations without SKUs can't be told apart, so their
// item is marked in `blind`.
export function ebayStockPage(
	body: string,
	places: Map<string, Place[]>,
	blind: Set<string>,
): number {
	const response = stockPage.assert(xml.parse(body)).GetMyeBaySellingResponse;
	if (response.Ack === "Failure")
		throw new Error(
			`eBay refused the listings: ${response.Errors?.map((e) => e.LongMessage).join("; ")}`,
		);
	const add = (key: string, place: Place) =>
		places.set(key, [...(places.get(key) ?? []), place]);
	for (const item of response.ActiveList?.ItemArray?.Item ?? []) {
		if (!item.Variations) {
			add(item.SKU?.trim() || item.ItemID, {
				itemId: item.ItemID,
				variationSku: null,
				shows: item.QuantityAvailable ?? null,
			});
			continue;
		}
		for (const v of item.Variations.Variation) {
			const sku = v.SKU?.trim();
			if (!sku) {
				blind.add(item.ItemID);
				continue;
			}
			add(sku, {
				itemId: item.ItemID,
				variationSku: sku,
				shows: v.Quantity - (v.SellingStatus?.QuantitySold ?? 0),
			});
		}
	}
	return response.ActiveList?.PaginationResult.TotalNumberOfPages ?? 0;
}

export function ebayStockFound(places: Place[]): Found<Target> {
	const shown = new Set(places.map((p) => p.shows));
	return {
		state: "ready",
		target: {
			items: places.map(({ itemId, variationSku }) => ({
				itemId,
				variationSku,
			})),
		},
		shows: shown.size === 1 ? [...shown][0] : null,
	};
}

async function trading(call: string, body: string) {
	const response = await fetch(`${API}/ws/api.dll`, {
		method: "POST",
		headers: {
			"X-EBAY-API-CALL-NAME": call,
			"X-EBAY-API-SITEID": "0",
			"X-EBAY-API-COMPATIBILITY-LEVEL": "1349",
			"X-EBAY-API-IAF-TOKEN": await accessToken(),
			"Content-Type": "text/xml",
		},
		body,
	});
	if (!response.ok)
		throw new Error(
			`eBay answered ${response.status}: ${await response.text()}`,
		);
	return response.text();
}

async function read() {
	const places = new Map<string, Place[]>();
	const blind = new Set<string>();
	for (let page = 1, pages = 1; page <= pages; page++) {
		pages = ebayStockPage(
			await trading(
				"GetMyeBaySelling",
				`<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
	<ActiveList>
		<Include>true</Include>
		<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
	</ActiveList>
	<OutputSelector>ActiveList.ItemArray.Item.ItemID</OutputSelector>
	<OutputSelector>ActiveList.ItemArray.Item.SKU</OutputSelector>
	<OutputSelector>ActiveList.ItemArray.Item.QuantityAvailable</OutputSelector>
	<OutputSelector>ActiveList.ItemArray.Item.Variations</OutputSelector>
	<OutputSelector>ActiveList.PaginationResult</OutputSelector>
</GetMyeBaySellingRequest>`,
			),
			places,
			blind,
		);
	}
	const found = new Map<string, Found<Target>>();
	for (const itemId of blind)
		found.set(itemId, {
			state: "unpushable",
			reason:
				"its eBay variations have no SKUs, so katasync can't tell them apart",
		});
	for (const [key, list] of places) found.set(key, ebayStockFound(list));
	return found;
}

export const ebayStock: StockChannel<Target> = {
	name: "eBay",
	target,
	read,
};
