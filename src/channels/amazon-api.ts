import { type } from "arktype";

// The Selling Partner API client for Amazon US.
const ENDPOINT = "https://sellingpartnerapi-na.amazon.com";
export const MARKETPLACE_US = "ATVPDKIKX0DER";

let cachedToken: { value: string; expiresAt: number } | undefined;

// Trades the long-lived refresh token for a 1-hour access token. Amazon's
// refresh token doesn't change when used, so sharing it is safe.
export async function accessToken() {
	if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
		return cachedToken.value;
	}
	const { AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, AMAZON_REFRESH_TOKEN } =
		process.env;
	if (!AMAZON_CLIENT_ID || !AMAZON_CLIENT_SECRET || !AMAZON_REFRESH_TOKEN) {
		throw new Error(
			"Set AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, and AMAZON_REFRESH_TOKEN",
		);
	}
	const response = await fetch("https://api.amazon.com/auth/o2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: AMAZON_REFRESH_TOKEN,
			client_id: AMAZON_CLIENT_ID,
			client_secret: AMAZON_CLIENT_SECRET,
		}),
	});
	if (!response.ok) {
		throw new Error(
			`Amazon login failed: ${response.status} ${await response.text()}`,
		);
	}
	const body = type({ access_token: "string", expires_in: "number" }).assert(
		await response.json(),
	);
	cachedToken = {
		value: body.access_token,
		expiresAt: Date.now() + body.expires_in * 1000,
	};
	return cachedToken.value;
}

// GETs an SP-API path, or POSTs `body` to it, waiting and retrying when
// Amazon says to slow down. Order lists allow about one call a minute once
// the burst is spent.
export async function spApi(path: string, body?: unknown): Promise<unknown> {
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(`${ENDPOINT}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"x-amz-access-token": await accessToken(),
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (response.status === 429 && attempt < 8) {
			const rate = Number(response.headers.get("x-amzn-ratelimit-limit"));
			const wait = rate > 0 ? Math.max(2000, 1000 / rate) : 2000 * attempt;
			await new Promise((resolve) => setTimeout(resolve, wait));
			continue;
		}
		if (!response.ok) {
			throw new Error(
				`Amazon answered ${response.status}: ${await response.text()}`,
			);
		}
		return response.json();
	}
}
