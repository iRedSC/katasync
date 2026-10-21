import { type } from "arktype";

const API_VERSION = "2026-10";

function credentials() {
	const domain = process.env.SHOPIFY_STORE_DOMAIN;
	const token = process.env.SHOPIFY_ADMIN_TOKEN;
	if (!domain || !token) {
		throw new Error("Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN");
	}
	return { domain, token };
}

const graphqlResponse = type({
	"data?": "unknown",
	"errors?": type({
		message: "string",
		"extensions?": { "code?": "string" },
	}).array(),
});

// Calls the Admin GraphQL API, waiting and retrying when Shopify throttles.
// With timeoutMs, gives up once that long has passed, throttle waits
// included.
export async function shopifyQuery(
	query: string,
	variables: Record<string, unknown>,
	{ timeoutMs }: { timeoutMs?: number } = {},
) {
	const { domain, token } = credentials();
	const deadline = timeoutMs
		? Date.now() + timeoutMs
		: Number.POSITIVE_INFINITY;
	for (let attempt = 1; ; attempt++) {
		let body: typeof graphqlResponse.infer;
		try {
			const response = await fetch(
				`https://${domain}/admin/api/${API_VERSION}/graphql.json`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Shopify-Access-Token": token,
					},
					body: JSON.stringify({ query, variables }),
					signal: timeoutMs
						? AbortSignal.timeout(Math.max(1, deadline - Date.now()))
						: undefined,
				},
			);
			if (!response.ok) {
				throw new Error(
					`Shopify answered ${response.status}: ${await response.text()}`,
				);
			}
			body = graphqlResponse.assert(await response.json());
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") {
				throw new Error(`Shopify didn't answer within ${timeoutMs}ms`);
			}
			throw err;
		}
		const throttled = body.errors?.some(
			(e) => e.extensions?.code === "THROTTLED",
		);
		const wait = 2000 * attempt;
		if (throttled && attempt < 6 && Date.now() + wait < deadline) {
			await new Promise((resolve) => setTimeout(resolve, wait));
			continue;
		}
		if (body.errors?.length) {
			throw new Error(
				`Shopify error: ${body.errors.map((e) => e.message).join("; ")}`,
			);
		}
		return body.data;
	}
}

export const userErrors = type({
	field: "string[] | null",
	message: "string",
}).array();

// Calls the Admin REST API, for the few things GraphQL can't reach with the
// app's scopes (Shopify Payments payouts need account access there, but only
// read_shopify_payments_payouts here). Follows the Link header's next page.
export async function shopifyRest(
	path: string,
): Promise<{ body: unknown; next: string | null }> {
	const { domain, token } = credentials();
	const url = path.startsWith("https://")
		? path
		: `https://${domain}/admin/api/${API_VERSION}/${path}`;
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(url, {
			headers: { "X-Shopify-Access-Token": token },
		});
		if (response.status === 429 && attempt < 6) {
			const wait = Number(response.headers.get("retry-after") ?? "2");
			await new Promise((done) => setTimeout(done, wait * 1000));
			continue;
		}
		if (!response.ok)
			throw new Error(
				`Shopify answered ${response.status}: ${await response.text()}`,
			);
		const link = response.headers.get("link") ?? "";
		const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
		return { body: await response.json(), next };
	}
}
