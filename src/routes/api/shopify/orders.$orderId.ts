import { createFileRoute } from "@tanstack/react-router";

// Sends a page's link on to the order in Shopify's admin (shopifyOrderLink):
// the store's handle is server-only. Needs a session (the sign-in guard).
export const Route = createFileRoute("/api/shopify/orders/$orderId")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { shopifyAdminOrderUrl } = await import(
					"#/channels/shopify/admin-url"
				);
				if (!/^\d+$/.test(params.orderId))
					return new Response("Not a Shopify order id", { status: 404 });
				const url = shopifyAdminOrderUrl(params.orderId);
				if (!url)
					return new Response(
						"Set SHOPIFY_STORE_DOMAIN to open orders in Shopify",
						{ status: 500 },
					);
				return Response.redirect(url, 302);
			},
		},
	},
});
