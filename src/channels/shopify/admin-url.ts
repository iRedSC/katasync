// An order's page in Shopify's admin, from its numeric id, or null when
// SHOPIFY_STORE_DOMAIN isn't set.
export function shopifyAdminOrderUrl(id: string): string | null {
	const handle = process.env.SHOPIFY_STORE_DOMAIN?.replace(
		".myshopify.com",
		"",
	);
	if (!handle || !id) return null;
	return `https://admin.shopify.com/store/${handle}/orders/${encodeURIComponent(id)}`;
}
