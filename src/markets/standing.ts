import { type } from "arktype";
import type { Market } from "./market";

// Where each marketplace says the seller account stands, in one shape:
// the marketplace's own verdict, its metrics against its limits, and the
// problems to act on. Parsers here are pure; src/markets/refresh.ts fetches.

export type Level = "good" | "watch" | "at_risk";

export type Metric = {
	label: string;
	value:
		| { kind: "rate"; rate: number; count: number | null; of: number | null }
		| { kind: "count"; count: number }
		// The marketplace's own words, where it rates rather than measures.
		| { kind: "rating"; text: string };
	// The marketplace's limit: stay below it, above it, or at zero.
	target: { kind: "below" | "above"; value: number } | null;
	level: Level;
	// The days the marketplace measured, as ISO dates.
	window: { from: string; to: string } | null;
};

// One listing or order a problem is about, in the marketplace's words.
export type ProblemItem = {
	// The channel's ID for the listing as katasync keeps it
	// (listings.external_id), to find our product; null for an order.
	listingId: string | null;
	// What the marketplace calls it: its SKU, or the order's name.
	ref: string;
	label: string;
	// What the marketplace says about this one.
	detail: string | null;
	// Where to fix it on the marketplace.
	href: string | null;
};

export type Problem = {
	level: Exclude<Level, "good">;
	text: string;
	href: string | null;
	// What the marketplace says about it as a whole: what happened, or how
	// to fix it.
	detail: string | null;
	items: ProblemItem[];
};

// The marketplace's own verdict on the account, or why there isn't one,
// with the one thing that would fix that.
export type Verdict =
	| { state: "read"; level: Level; summary: string }
	// The token lacks a permission; `fix` says which sign-in grants it.
	| { state: "needs_access"; fix: string }
	// Amazon is still building the first report.
	| { state: "waiting" };

// What a check found. Problems stand on their own: a marketplace that
// won't give its verdict can still say which listings it blocked.
export type Standing = {
	// The worst of the verdict, metrics, and problems; null when there's no
	// verdict and nothing found, since that's not knowing, not good.
	level: Level | null;
	verdict: Verdict;
	metrics: Metric[];
	problems: Problem[];
};

// Where a person sees it on the marketplace itself.
export const STANDING_PAGES: Record<Market, string> = {
	amazon: "https://sellercentral.amazon.com/performance/account/health",
	ebay: "https://www.ebay.com/sh/performance/dashboard",
	// Seller Center's own pages need its sign-in to find; its home is sure.
	tiktok: "https://seller-us.tiktok.com/",
	shopify: "https://admin.shopify.com/payments/disputes",
};

const order: Level[] = ["good", "watch", "at_risk"];
export const worst = (levels: Level[]): Level =>
	levels.reduce<Level>(
		(w, l) => (order.indexOf(l) > order.indexOf(w) ? l : w),
		"good",
	);

// The only way to make a Standing, so its level always agrees with what's
// in it. Problems come worst first.
export function standing(
	verdict: Verdict,
	metrics: Metric[],
	problems: Problem[],
): Standing {
	const levels = [
		...(verdict.state === "read" ? [verdict.level] : []),
		...metrics.map((m) => m.level),
		...problems.map((p) => p.level),
	];
	return {
		level: levels.length === 0 ? null : worst(levels),
		verdict,
		metrics,
		problems: [...problems].sort(
			(a, b) => order.indexOf(b.level) - order.indexOf(a.level),
		),
	};
}

export const withProblems = (s: Standing, more: Problem[]): Standing =>
	standing(s.verdict, s.metrics, [...s.problems, ...more]);

// A problem about the account as a whole, with nothing to list under it.
const accountProblem = (
	level: Problem["level"],
	text: string,
	href: string,
	detail: string | null = null,
): Problem => ({ level, text, href, detail, items: [] });

// --- Amazon: GET_V2_SELLER_PERFORMANCE_REPORT -------------------------------

// A status Amazon hasn't documented reads as worth a look, not as fine.
function amazonLevel(status: string | undefined): Level {
	switch ((status ?? "").toUpperCase()) {
		case "GOOD":
		case "GREAT":
		case "NONE":
		case "NORMAL":
			return "good";
		case "FAIR":
			return "watch";
		case "BAD":
		case "POOR":
		case "AT_RISK":
		case "CRITICAL":
		case "DEACTIVATED":
			return "at_risk";
		default:
			return "watch";
	}
}

const window = type({
	reportingDateFrom: "string",
	reportingDateTo: "string",
});
const rateMetric = type({
	"reportingDateRange?": window,
	"status?": "string",
	"targetValue?": "number",
	"targetCondition?": "string",
	"rate?": "number",
	"orderCount?": "number",
	"shipmentCount?": "number",
	"shipmentCountWithValidTracking?": "number",
	"+": "ignore",
});
type RateMetric = typeof rateMetric.infer;

export const amazonReport = type({
	accountStatuses: type({ marketplaceId: "string", status: "string" }).array(),
	performanceMetrics: type({
		marketplaceId: "string",
		"accountHealthRating?": {
			"ahrStatus?": "string",
			"ahrScore?": "number",
			"+": "ignore",
		},
		"orderDefectRate?": { "afn?": rateMetric, "mfn?": rateMetric },
		"lateShipmentRate?": rateMetric,
		"preFulfillmentCancellationRate?": rateMetric,
		"validTrackingRate?": rateMetric,
		"onTimeDeliveryRate?": rateMetric,
		"policyViolationWarnings?": {
			"warningsCount?": "number",
			"+": "ignore",
		},
		"warningStates?": type({
			"warningType?": "string",
			"status?": "string",
			"+": "ignore",
		}).array(),
		"[string]": "unknown",
	}).array(),
});

// Amazon's policy areas: each holds a defectsCount and a status. Named here
// so the page says what they are; one Amazon adds later still shows, in its
// own words.
const POLICIES: Record<string, string> = {
	listingPolicyViolations: "listing policy violations",
	productAuthenticityCustomerComplaints: "product authenticity complaints",
	productConditionCustomerComplaints: "product condition complaints",
	productSafetyCustomerComplaints: "product safety complaints",
	receivedIntellectualPropertyComplaints: "intellectual property complaints",
	suspectedIntellectualPropertyViolations:
		"suspected intellectual property violations",
	restrictedProductPolicyViolations: "restricted product violations",
	foodAndProductSafetyIssues: "food and product safety issues",
	customerProductReviewsPolicyViolations: "product review policy violations",
	otherPolicyViolations: "other policy violations",
	documentRequests: "document requests",
};
const policy = type({
	defectsCount: "number",
	"status?": "string",
	"+": "ignore",
});
// camelCase or SHOUTING_SNAKE as plain words.
const words = (key: string) =>
	key
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replaceAll("_", " ")
		.toLowerCase();

const day = (iso: string) => iso.slice(0, 10);

function amazonMetric(
	label: string,
	m: RateMetric | undefined,
	count: (m: RateMetric) => number | null,
): Metric[] {
	if (!m || m.rate === undefined) return [];
	const of =
		m.orderCount ?? m.shipmentCount ?? m.shipmentCountWithValidTracking ?? null;
	const condition = (m.targetCondition ?? "").toUpperCase();
	return [
		{
			label,
			value: { kind: "rate", rate: m.rate, count: count(m), of },
			target:
				m.targetValue === undefined
					? null
					: {
							kind: condition.startsWith("GREATER") ? "above" : "below",
							value: m.targetValue,
						},
			level: amazonLevel(m.status),
			window: m.reportingDateRange
				? {
						from: day(m.reportingDateRange.reportingDateFrom),
						to: day(m.reportingDateRange.reportingDateTo),
					}
				: null,
		},
	];
}

const share = (m: RateMetric) =>
	m.rate !== undefined && m.orderCount !== undefined
		? Math.round(m.rate * m.orderCount)
		: null;

export function amazonStanding(raw: unknown, marketplaceId: string): Standing {
	const report = amazonReport.assert(raw);
	const p = report.performanceMetrics.find(
		(m) => m.marketplaceId === marketplaceId,
	);
	const status = report.accountStatuses.find(
		(s) => s.marketplaceId === marketplaceId,
	)?.status;
	if (!p) throw new Error(`Amazon's report has no ${marketplaceId}`);
	const href = STANDING_PAGES.amazon;

	const ahr = p.accountHealthRating;
	const metrics: Metric[] = [
		...amazonMetric("Order defect rate", p.orderDefectRate?.mfn, share),
		...(p.orderDefectRate?.afn?.orderCount
			? amazonMetric("Order defect rate (FBA)", p.orderDefectRate.afn, share)
			: []),
		...amazonMetric("Late shipments", p.lateShipmentRate, share),
		...amazonMetric("Cancellations", p.preFulfillmentCancellationRate, share),
		...amazonMetric("Valid tracking", p.validTrackingRate, (m) =>
			m.rate !== undefined && m.shipmentCount !== undefined
				? Math.round(m.rate * m.shipmentCount)
				: null,
		),
		...amazonMetric("On-time delivery", p.onTimeDeliveryRate, (m) =>
			m.rate !== undefined && m.shipmentCountWithValidTracking !== undefined
				? Math.round(m.rate * m.shipmentCountWithValidTracking)
				: null,
		),
	];

	const problems: Problem[] = [];
	const accountLevel = amazonLevel(status);
	if (accountLevel !== "good")
		problems.push(
			accountProblem(
				accountLevel,
				`Account ${words(status ?? "unknown")}`,
				href,
			),
		);
	for (const [key, value] of Object.entries(p)) {
		const found = policy(value);
		if (found instanceof type.errors || found.defectsCount === 0) continue;
		const level = amazonLevel(found.status);
		problems.push(
			accountProblem(
				// A count above zero is never fine, whatever the status says.
				level === "good" ? "watch" : level,
				`${found.defectsCount} ${POLICIES[key] ?? words(key)}`,
				href,
				"Amazon's API gives only the count; Account Health in Seller Central lists them.",
			),
		);
	}
	const warnings = p.policyViolationWarnings?.warningsCount ?? 0;
	if (warnings > 0)
		problems.push(
			accountProblem(
				"watch",
				`${warnings} policy ${warnings === 1 ? "warning" : "warnings"}`,
				href,
			),
		);
	for (const w of p.warningStates ?? []) {
		const level = amazonLevel(w.status);
		if (level !== "good")
			problems.push(
				accountProblem(level, words(w.warningType ?? "warning"), href),
			);
	}

	const rating = ahr?.ahrStatus
		? `Account health ${words(ahr.ahrStatus)}${ahr.ahrScore === undefined ? "" : ` (${ahr.ahrScore})`}`
		: "Account health not rated";
	return standing(
		{
			state: "read",
			level: worst([accountLevel, amazonLevel(ahr?.ahrStatus)]),
			summary:
				accountLevel === "good" ? rating : `Account ${words(status ?? "")}`,
		},
		metrics,
		problems,
	);
}

// --- Shopify: chargebacks ---------------------------------------------------

// Shopify Payments has no account score; what puts the account at risk is
// chargebacks. One waiting on us is urgent, since an unanswered one is lost.
export type ShopifyDispute = {
	orderName: string;
	// The order in Shopify admin.
	href: string;
	status: string;
	// CHARGEBACK, or INQUIRY: the bank asking before it charges back.
	initiatedAs: string;
	// The order's total and when it was placed, to know which sale it is.
	total: string;
	placedAt: string;
};

export function shopifyStanding(
	open: ShopifyDispute[],
	lostLately: number,
): Standing {
	const problems: Problem[] = open.map((d) => {
		const what = d.initiatedAs === "INQUIRY" ? "Inquiry" : "Chargeback";
		const needsUs = d.status === "NEEDS_RESPONSE";
		return {
			level: needsUs ? "at_risk" : "watch",
			text: `${what} on ${d.orderName} ${needsUs ? "needs a response" : "under review"}`,
			href: d.href,
			detail: `${d.total} order placed ${d.placedAt.slice(0, 10)}. ${
				needsUs
					? "Send Shopify your evidence before its deadline, or the money is lost."
					: "The bank is deciding; nothing to do unless Shopify asks."
			}`,
			items: [],
		};
	});
	return standing(
		{
			state: "read",
			level: "good",
			summary:
				open.length === 0
					? "No open disputes"
					: `${open.length} open ${open.length === 1 ? "dispute" : "disputes"}`,
		},
		[
			{
				label: "Chargebacks lost, 90 days",
				value: { kind: "count", count: lostLately },
				target: null,
				level: lostLately > 0 ? "watch" : "good",
				window: null,
			},
		],
		problems,
	);
}
