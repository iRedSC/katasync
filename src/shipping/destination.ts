import { isShopifyRelayedTiktok, labelSource } from "#/orders/fulfillment";

// Where an order's tracking has to go, from where it was sold and whose
// label it ships on. A label and order that don't fit together (a TikTok
// sale on a Shippo label, a Shippo label for a channel katasync doesn't
// fulfill) is held: katasync can't tell which marketplace the box answers
// to.
export type Destination =
	| { kind: "shopify" }
	| { kind: "ebay" }
	| { kind: "tiktok"; orderId: string; relayed: boolean }
	| { kind: "hold"; why: string };

export function destinationOf(
	order: {
		channel: string;
		salesChannel: string | null;
		shipCountry: string | null;
		marketplaceOrderId: string | null;
	},
	providers: string[],
): Destination {
	const source = labelSource(order);
	const all = (p: string) =>
		providers.length > 0 && providers.every((x) => x === p);
	if (source === "tiktok") {
		const id = order.marketplaceOrderId?.startsWith("tiktok:")
			? order.marketplaceOrderId.slice("tiktok:".length)
			: null;
		if (!all("tiktok") || !id) {
			return {
				kind: "hold",
				why: "A TikTok sale that isn't on TikTok's own label; fulfill it in TikTok Seller Center",
			};
		}
		return {
			kind: "tiktok",
			orderId: id,
			relayed: isShopifyRelayedTiktok(order),
		};
	}
	if (source === "shippo" && all("shippo")) {
		if (order.channel === "shopify") return { kind: "shopify" };
		if (order.channel === "ebay") return { kind: "ebay" };
	}
	return {
		kind: "hold",
		why: "This label doesn't match where the order was sold; tell the marketplace by hand",
	};
}
