import { type } from "arktype";
import { shopCipher, tiktokApi } from "#/channels/tiktok";
import {
	type Level,
	type Problem,
	type ProblemItem,
	STANDING_PAGES,
	type Standing,
	standing,
	type Verdict,
} from "./standing";

// TikTok Shop: its Shop Performance Score (SPS) as the verdict, and the
// products TikTok failed in review, froze, or took down, with its reasons.
// SPS needs a scope not among TIKTOK_SCOPES yet (until it's approved in
// Partner Center and the shop authorizes again, the verdict says so); the
// products need only seller.product.basic, which the app has. Violation
// points have no public API; Seller Center shows them.

const OVERVIEW = "/analytics/202606/shop_performances/overview";

const score = type({
	"sps_score?": "string | number",
	"sps_tier?": "string",
	"last_updated_date?": "string",
	"+": "ignore",
});

// TikTok hasn't published every tier; one it hasn't is worth a look.
function tierLevel(tier: string): Level {
	const t = tier.toLowerCase();
	if (/excellent|great|good/.test(t)) return "good";
	if (/poor|bad|risk|low|critical/.test(t)) return "at_risk";
	return "watch";
}

// The overview's data is documented as a list of one; accept it bare too.
export function tiktokVerdict(data: unknown): Verdict {
	const found = score.assert(Array.isArray(data) ? data[0] : data);
	if (found.sps_tier === undefined)
		throw new Error("TikTok's performance overview has no sps_tier");
	return {
		state: "read",
		level: tierLevel(found.sps_tier),
		summary: `Shop performance ${found.sps_tier}${found.sps_score === undefined ? "" : ` (${found.sps_score})`}`,
	};
}

// Products TikTok stopped, worst first. FAILED never went live; the others
// were live and TikTok took them down.
const STOPPED = {
	PLATFORM_DEACTIVATED: { level: "at_risk", text: "Taken down" },
	FREEZE: { level: "at_risk", text: "Frozen" },
	FAILED: { level: "watch", text: "Failed review" },
} as const satisfies Record<string, { level: Problem["level"]; text: string }>;
type Stopped = keyof typeof STOPPED;

const searchPage = type({
	"products?": type({
		id: "string",
		title: "string",
		skus: type({
			id: "string",
			"seller_sku?": "string",
			"+": "ignore",
		}).array(),
		"+": "ignore",
	}).array(),
	"next_page_token?": "string",
	"+": "ignore",
});

export const productDetail = type({
	"audit_failed_reasons?": type({
		"position?": "string",
		"reasons?": "string[]",
		"suggestions?": "string[]",
		"+": "ignore",
	}).array(),
	"+": "ignore",
});

export type StoppedProduct = {
	status: Stopped;
	id: string;
	title: string;
	skuId: string | null;
	sellerSku: string | null;
	detail: typeof productDetail.infer;
};

// TikTok writes its suggestions as HTML.
const plain = (html: string) =>
	html
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();

// One problem per status and reason, listing the products it's about. A
// product is one item however often a reason names it, keyed by its ID: two
// products can share a seller SKU, and a blank one names nothing.
export function tiktokProblems(products: StoppedProduct[]): Problem[] {
	const groups = new Map<string, Problem>();
	const listed = new Map<string, { item: ProblemItem; pieces: Set<string> }>();
	for (const p of products) {
		const stopped = STOPPED[p.status];
		const sku = p.sellerSku?.trim() || null;
		const reasons = p.detail.audit_failed_reasons ?? [];
		const flat = reasons.length
			? reasons.flatMap((r) =>
					(r.reasons?.length ? r.reasons : ["No reason given"]).map(
						(reason) => ({
							reason,
							position: r.position ?? null,
							suggestion: r.suggestions?.[0] ? plain(r.suggestions[0]) : null,
						}),
					),
				)
			: [{ reason: "No reason given", position: null, suggestion: null }];
		for (const r of flat) {
			const key = `${p.status}|${r.reason}`;
			const group = groups.get(key) ?? {
				level: stopped.level,
				text: `${stopped.text}: ${r.reason}`,
				href: STANDING_PAGES.tiktok,
				detail: r.suggestion,
				items: [],
			};
			const itemKey = JSON.stringify([key, p.id]);
			let entry = listed.get(itemKey);
			if (!entry) {
				const item: ProblemItem = {
					listingId: p.skuId,
					ref: sku ?? p.id,
					label: p.title,
					detail: null,
					href: null,
				};
				entry = { item, pieces: new Set() };
				listed.set(itemKey, entry);
				group.items.push(item);
			}
			// Repeated evidence for the same product adds its corrections rather
			// than replacing them.
			if (r.suggestion && r.suggestion !== group.detail)
				entry.pieces.add(r.suggestion);
			if (r.position) entry.pieces.add(`In ${r.position.toLowerCase()}`);
			entry.item.detail = [...entry.pieces].join(" ") || null;
			groups.set(key, group);
		}
	}
	return [...groups.values()];
}

async function stoppedProducts(): Promise<StoppedProduct[]> {
	const cipher = await shopCipher();
	const found: StoppedProduct[] = [];
	for (const status of Object.keys(STOPPED) as Stopped[]) {
		let pageToken: string | undefined;
		do {
			const page = searchPage.assert(
				await tiktokApi(
					"/product/202309/products/search",
					{
						shop_cipher: cipher,
						page_size: "100",
						...(pageToken ? { page_token: pageToken } : {}),
					},
					{ status },
				),
			);
			for (const p of page.products ?? []) {
				const detail = productDetail.assert(
					await tiktokApi(`/product/202309/products/${p.id}`, {
						shop_cipher: cipher,
					}),
				);
				found.push({
					status,
					id: p.id,
					title: p.title,
					skuId: p.skus[0]?.id ?? null,
					sellerSku: p.skus[0]?.seller_sku ?? null,
					detail,
				});
			}
			pageToken = page.next_page_token || undefined;
		} while (pageToken);
	}
	return found;
}

async function verdict(): Promise<Verdict> {
	try {
		return tiktokVerdict(
			await tiktokApi(OVERVIEW, { shop_cipher: await shopCipher() }),
		);
	} catch (error) {
		// 105005: the app wasn't granted the endpoint's scope.
		if (error instanceof Error && error.message.includes("105005"))
			return {
				state: "needs_access",
				fix: "Add the shop analytics permission to the app in TikTok Partner Center, then run pnpm tiktok:authorize.",
			};
		throw error;
	}
}

export async function tiktokStanding(): Promise<Standing> {
	const [v, products] = await Promise.all([verdict(), stoppedProducts()]);
	return standing(v, [], tiktokProblems(products));
}
