// Shopify's shipping email links to the storefront's tracking page, not the
// carrier's: <STOREFRONT_ORIGIN>/track/<order number>/<signature>. The
// signature lets the page show an order to whoever has the link without
// order ids being guessable. The storefront checks it with the same
// TRACKING_LINK_SECRET, so the two must stay in step.

// HMAC-SHA256 of "track:<id>", base64url without padding (43 characters).
export async function trackingSignature(secret: string, orderNumber: string) {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(`track:${orderNumber}`),
	);
	return Buffer.from(signature).toString("base64url");
}

// The storefront page for a Shopify order, or null (with a warning) when
// it can't be made, so the email keeps the carrier's link instead of a
// broken one.
export async function storefrontTrackingUrl(
	shopifyOrderId: string,
): Promise<string | null> {
	const secret = process.env.TRACKING_LINK_SECRET;
	const origin = process.env.STOREFRONT_ORIGIN;
	const orderNumber = /^gid:\/\/shopify\/Order\/(\d+)$/.exec(
		shopifyOrderId,
	)?.[1];
	let base: string | null = null;
	try {
		if (origin) base = new URL(origin).origin;
	} catch {
		// Reported below.
	}
	if (!secret || !base || !orderNumber) {
		const why = !secret
			? "TRACKING_LINK_SECRET isn't set"
			: !base
				? "STOREFRONT_ORIGIN isn't a URL"
				: `${shopifyOrderId} isn't a Shopify order id`;
		console.warn(
			`Shipping email for ${shopifyOrderId} links to the carrier, not the storefront: ${why}`,
		);
		return null;
	}
	return `${base}/track/${orderNumber}/${await trackingSignature(secret, orderNumber)}`;
}
