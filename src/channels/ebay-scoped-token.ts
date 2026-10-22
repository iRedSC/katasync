import { type } from "arktype";
import { API } from "./ebay";

// An eBay access token for one scope alone, for scopes the shared refresh
// token wasn't granted at first: asking for them with sync's would break
// sync until someone signs in again (pnpm ebay:authorize). Null until then.

const cached = new Map<string, { value: string; expiresAt: number }>();

export async function scopedToken(scope: string): Promise<string | null> {
	const hit = cached.get(scope);
	if (hit && hit.expiresAt > Date.now() + 60_000) return hit.value;
	const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN } =
		process.env;
	if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_REFRESH_TOKEN)
		throw new Error(
			"Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REFRESH_TOKEN",
		);
	const response = await fetch(`${API}/identity/v1/oauth2/token`, {
		method: "POST",
		headers: {
			Authorization: `Basic ${Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64")}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: EBAY_REFRESH_TOKEN,
			scope,
		}),
	});
	const text = await response.text();
	if (response.status === 400 && text.includes("invalid_scope")) return null;
	if (!response.ok)
		throw new Error(`eBay login failed: ${response.status} ${text}`);
	const body = type({ access_token: "string", expires_in: "number" }).assert(
		JSON.parse(text),
	);
	cached.set(scope, {
		value: body.access_token,
		expiresAt: Date.now() + body.expires_in * 1000,
	});
	return body.access_token;
}
