import { type } from "arktype";
import { API } from "#/channels/ebay";
import {
	type Level,
	type Metric,
	type Problem,
	STANDING_PAGES,
	type Standing,
	standing,
} from "./standing";

// eBay's seller level and its buyers' complaint rates against similar
// sellers, from the Sell Analytics API. It needs sell.analytics.readonly,
// which the shared token didn't grant at first; until someone signs in again
// (pnpm ebay:authorize) this says so instead of failing.

const ANALYTICS_SCOPE =
	"https://api.ebay.com/oauth/api_scope/sell.analytics.readonly";

let cached: { value: string; expiresAt: number } | undefined;

// An access token for analytics alone, so sync's token never asks for a
// scope that might not be granted. Null when it isn't.
async function analyticsToken(): Promise<string | null> {
	if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
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
			scope: ANALYTICS_SCOPE,
		}),
	});
	const text = await response.text();
	if (response.status === 400 && text.includes("invalid_scope")) return null;
	if (!response.ok)
		throw new Error(`eBay login failed: ${response.status} ${text}`);
	const body = type({ access_token: "string", expires_in: "number" }).assert(
		JSON.parse(text),
	);
	cached = {
		value: body.access_token,
		expiresAt: Date.now() + body.expires_in * 1000,
	};
	return cached.value;
}

export const sellerProfile = type({
	standardsLevel: "string",
	"evaluationReason?": "string",
	"metrics?": type({
		"name?": "string",
		"metricKey?": "string",
		"level?": "string",
		"+": "ignore",
	}).array(),
	"+": "ignore",
});

export const serviceMetric = type({
	"dimensionMetrics?": type({
		"metrics?": type({
			metricKey: "string",
			"benchmark?": { "rating?": "string", "+": "ignore" },
			"+": "ignore",
		}).array(),
		"+": "ignore",
	}).array(),
	"+": "ignore",
});

const LEVELS: Record<string, { level: Level; text: string }> = {
	TOP_RATED: { level: "good", text: "Top rated" },
	ABOVE_STANDARD: { level: "good", text: "Above standard" },
	BELOW_STANDARD: { level: "at_risk", text: "Below standard" },
};
const RATINGS: Record<string, { level: Level; text: string }> = {
	LOW: { level: "good", text: "Low next to similar sellers" },
	AVERAGE: { level: "good", text: "Average next to similar sellers" },
	HIGH: { level: "watch", text: "High next to similar sellers" },
	// eBay limits sellers whose rate stays very high.
	VERY_HIGH: { level: "at_risk", text: "Very high next to similar sellers" },
};
const SERVICE: Record<string, string> = {
	ITEM_NOT_RECEIVED: "Item not received",
	ITEM_NOT_AS_DESCRIBED: "Not as described",
};

// The parsed answers. A metric eBay rates nothing (too few sales) is left
// out rather than shown as fine.
export function ebayRead(
	raw: unknown,
	service: Partial<Record<keyof typeof SERVICE, unknown>>,
): Standing {
	const profile = sellerProfile.assert(raw);
	const known = LEVELS[profile.standardsLevel];
	const verdict = known?.level ?? "watch";
	const href = STANDING_PAGES.ebay;
	const problems: Problem[] = (profile.metrics ?? []).flatMap((m) =>
		m.level === "BELOW_STANDARD"
			? [
					{
						level: "at_risk" as const,
						text: `${m.name ?? m.metricKey ?? "A metric"} below standard`,
						href,
						detail: profile.evaluationReason ?? null,
						items: [],
					},
				]
			: [],
	);
	const metrics: Metric[] = Object.entries(service).flatMap(([key, value]) => {
		const rating = serviceMetric(value);
		if (rating instanceof type.errors) return [];
		const rate = rating.dimensionMetrics
			?.flatMap((d) => d.metrics ?? [])
			.find((m) => m.metricKey === "RATE")?.benchmark?.rating;
		const r = rate ? RATINGS[rate] : undefined;
		if (!rate) return [];
		return [
			{
				label: SERVICE[key] ?? key,
				value: { kind: "rating", text: r?.text ?? rate.toLowerCase() },
				target: null,
				level: r?.level ?? "watch",
				window: null,
			},
		];
	});
	return standing(
		{
			state: "read",
			level: verdict,
			summary:
				known?.text ??
				profile.standardsLevel.replaceAll("_", " ").toLowerCase(),
		},
		metrics,
		problems,
	);
}

async function get(token: string, path: string) {
	const response = await fetch(`${API}${path}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
	// No rating yet (too few sales): nothing to show, not a failure.
	if (response.status === 204 || response.status === 404) return null;
	if (!response.ok)
		throw new Error(
			`eBay answered ${response.status} on ${path}: ${await response.text()}`,
		);
	return response.json();
}

export async function ebayStanding(): Promise<Standing> {
	const token = await analyticsToken();
	if (!token)
		return standing(
			{
				state: "needs_access",
				fix: "Run pnpm ebay:authorize and sign in to eBay once to share seller standards.",
			},
			[],
			[],
		);
	const base = "/sell/analytics/v1";
	const [profile, notReceived, notAsDescribed] = await Promise.all([
		get(token, `${base}/seller_standards_profile/PROGRAM_US/CURRENT`),
		...(["ITEM_NOT_RECEIVED", "ITEM_NOT_AS_DESCRIBED"] as const).map((k) =>
			get(
				token,
				`${base}/customer_service_metric/${k}/CURRENT?evaluation_marketplace_id=EBAY_US`,
			),
		),
	]);
	if (!profile) throw new Error("eBay has no US seller standards profile");
	return ebayRead(profile, {
		ITEM_NOT_RECEIVED: notReceived,
		ITEM_NOT_AS_DESCRIBED: notAsDescribed,
	});
}
