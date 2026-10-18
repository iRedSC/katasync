import { type } from "arktype";
import { shopifyQuery, userErrors } from "./client";

// The storefront's tracking page looks labels up on Shippo, which wants
// Shippo's carrier token ("usps"), not the name Shopify shows ("USPS"). So
// each shipped label is also listed on the order, one entry per tracking
// number: metafield katasync.shippo_tracking, type json, value
// [{ "number": "9400...", "carrier": "usps", "url": "https://..." }]. url is
// the carrier's own tracking page, null when Shippo gave none; the shipping
// email links to the storefront's page instead. Needs write_orders.
export const shippoTrackingList = type({
	number: "string",
	carrier: "string",
	"url?": "string | null",
}).array();
export type ShippoTracking = typeof shippoTrackingList.infer;

const shippoTrackingRead = type({
	order: type({
		metafield: type({ value: "string", compareDigest: "string" }).or("null"),
	}).or("null"),
});

const metafieldsSaved = type({ metafieldsSet: { userErrors } });

// Each call gives up after this long. The fulfillment already went through,
// so a slow Shopify is noted rather than waited on.
const SHIPPO_TRACKING_TIMEOUT_MS = 5000;

// Reads the list, changes it, and writes it back only if Shopify still has
// what was read, so a concurrent edit fails instead of being lost.
async function changeShippoTracking(
	orderId: string,
	change: (list: ShippoTracking) => ShippoTracking,
) {
	const { order } = shippoTrackingRead.assert(
		await shopifyQuery(
			'query($id: ID!) { order(id: $id) { metafield(namespace: "katasync", key: "shippo_tracking") { value compareDigest } } }',
			{ id: orderId },
			{ timeoutMs: SHIPPO_TRACKING_TIMEOUT_MS },
		),
	);
	if (!order) throw new Error("Shopify has no such order");
	const current = order.metafield
		? shippoTrackingList.assert(JSON.parse(order.metafield.value))
		: [];
	const next = change(current);
	if (JSON.stringify(next) === JSON.stringify(current)) return;
	const { metafieldsSet } = metafieldsSaved.assert(
		await shopifyQuery(
			"mutation($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }",
			{
				metafields: [
					{
						ownerId: orderId,
						namespace: "katasync",
						key: "shippo_tracking",
						type: "json",
						value: JSON.stringify(next),
						compareDigest: order.metafield?.compareDigest ?? null,
					},
				],
			},
			{ timeoutMs: SHIPPO_TRACKING_TIMEOUT_MS },
		),
	);
	if (metafieldsSet.userErrors.length > 0) {
		throw new Error(
			`Shopify refused: ${metafieldsSet.userErrors.map((e) => e.message).join("; ")}`,
		);
	}
}

// Adds a label to the order's list, replacing an entry with the same number.
export function shopifySaveShippoTracking(
	orderId: string,
	entry: ShippoTracking[number],
) {
	return changeShippoTracking(orderId, (list) => [
		...list.filter((e) => e.number !== entry.number),
		entry,
	]);
}

// Takes a voided label off the order's list. Nothing to do if it isn't there.
export function shopifyRemoveShippoTracking(orderId: string, number: string) {
	return changeShippoTracking(orderId, (list) =>
		list.filter((e) => e.number !== number),
	);
}
