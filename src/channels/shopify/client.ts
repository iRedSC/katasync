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
