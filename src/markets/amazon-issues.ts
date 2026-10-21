import { type } from "arktype";
import { MARKETPLACE_US, spApi } from "#/channels/amazon-api";
import type { Problem } from "./standing";

// The listings Amazon has a problem with, from the Listings Items API: each
// error in Amazon's words, and what Amazon did about it (suppressed the
// listing, hid it from search). Warnings are left out: they're mostly
// suggestions (add attributes, try FBA), not problems.

const ENFORCED: Record<string, { level: Problem["level"]; text: string }> = {
	LISTING_SUPPRESSED: { level: "at_risk", text: "Listing suppressed" },
	CATALOG_ITEM_REMOVED: { level: "at_risk", text: "Removed from catalog" },
	SEARCH_SUPPRESSED: { level: "watch", text: "Hidden from search" },
	ATTRIBUTE_SUPPRESSED: { level: "watch", text: "Detail hidden" },
};

const issue = type({
	code: "string",
	message: "string",
	severity: "string",
	"categories?": "string[]",
	"enforcements?": {
		"actions?": type({ action: "string" }).array(),
		"+": "ignore",
	},
	"+": "ignore",
});

export const listingsPage = type({
	"items?": type({
		sku: "string",
		"summaries?": type({
			"asin?": "string",
			"itemName?": "string",
			"+": "ignore",
		}).array(),
		"issues?": issue.array(),
		"+": "ignore",
	}).array(),
	"pagination?": { "nextToken?": "string", "+": "ignore" },
	"+": "ignore",
});
type Item = NonNullable<typeof listingsPage.infer.items>[number];

const words = (key: string) =>
	key
		.replaceAll("_", " ")
		.toLowerCase()
		.replace(/^./, (c) => c.toUpperCase());

// A few words for the errors Amazon gives us most, so a row's title says
// what's wrong at a glance; Amazon's own explanation is in its details.
// Codes not here are named by Amazon's category.
const SHORT: Record<string, string> = {
	"5886": "Restricted generic ASIN",
	"8541": "Doesn't match Amazon's catalog",
	"18027": "Main image has text or a logo",
	"18299": "Needs brand approval",
	"18448": "Missing attributes",
	"18940": "Paused after cancelled orders",
	"19084": "Listing limitation",
	"90225": "A value is too long",
	"90244": "Invalid variation theme",
	"100581": "Main image has text or a logo",
	"100893": "Variation missing attributes",
	"101067": "Wrong product type",
};

// Where a seller fixes one listing.
export const amazonListingHref = (sku: string) =>
	`https://sellercentral.amazon.com/myinventory/inventory?searchField=all&searchTerm=${encodeURIComponent(sku)}`;

// One problem per enforcement and error code, listing its listings. Its
// title is a few words; what Amazon said is in its detail when every
// listing got the same message, else on each listing.
export function amazonIssueProblems(items: Item[]): Problem[] {
	const groups = new Map<string, Problem>();
	for (const item of items) {
		const summary = item.summaries?.[0];
		for (const i of item.issues ?? []) {
			const action = i.enforcements?.actions?.[0]?.action;
			const enforced = action ? ENFORCED[action] : undefined;
			if (i.severity !== "ERROR" && !action) continue;
			const key = `${action ?? ""}|${i.code}`;
			const what =
				SHORT[i.code] ??
				words(
					(i.categories ?? []).find(
						(c) => c !== "PRODUCT" && c !== "LISTING",
					) ?? "listing error",
				);
			const done = action ? (enforced?.text ?? words(action)) : null;
			const group = groups.get(key) ?? {
				level: enforced?.level ?? (action ? "at_risk" : "watch"),
				text: done ? `${done}: ${what}` : what,
				href: "https://sellercentral.amazon.com/fixyourproducts",
				detail: null,
				items: [],
			};
			// A listing with two errors of one kind (two fields too long) is
			// one row with both messages.
			const listed = group.items.find((x) => x.ref === item.sku);
			if (listed) listed.detail = `${listed.detail} ${i.message}`;
			else
				group.items.push({
					listingId: item.sku,
					ref: item.sku,
					label: summary?.itemName ?? summary?.asin ?? item.sku,
					detail: i.message,
					href: amazonListingHref(item.sku),
				});
			groups.set(key, group);
		}
	}
	return [...groups.values()].map((problem) => {
		const messages = new Set(problem.items.map((i) => i.detail));
		const same = messages.size === 1 ? [...messages][0] : null;
		return same
			? {
					...problem,
					detail: same,
					items: problem.items.map((i) => ({ ...i, detail: null })),
				}
			: problem;
	});
}

// Errors, and warnings in case Amazon enforces one; amazonIssueProblems
// keeps only errors and what's enforced.
export async function amazonListingIssues(): Promise<Problem[]> {
	const seller = process.env.AMAZON_SELLER_ID;
	if (!seller)
		throw new Error(
			"Set AMAZON_SELLER_ID to the merchant token to read listing issues",
		);
	const bySku = new Map<string, Item>();
	for (const severity of ["ERROR", "WARNING"]) {
		let token: string | undefined;
		do {
			const page = listingsPage.assert(
				await spApi(
					`/listings/2021-08-01/items/${seller}?marketplaceIds=${MARKETPLACE_US}&includedData=summaries,issues&withIssueSeverity=${severity}&pageSize=20${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
				),
			);
			// A listing with both comes back twice, with the same issues.
			for (const item of page.items ?? []) bySku.set(item.sku, item);
			token = page.pagination?.nextToken;
		} while (token);
	}
	return amazonIssueProblems([...bySku.values()]);
}
