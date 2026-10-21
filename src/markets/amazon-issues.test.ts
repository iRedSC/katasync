import { describe, expect, test } from "vitest";
import { amazonIssueProblems } from "./amazon-issues";

// Listings as the Listings Items API returns them, trimmed.
const listing = (
	sku: string,
	issues: {
		code: string;
		message: string;
		severity: string;
		categories?: string[];
		enforcements?: { actions: { action: string }[] };
	}[],
) => ({
	sku,
	summaries: [{ asin: `A-${sku}`, itemName: `Item ${sku}` }],
	issues,
});

describe("Amazon listing issues", () => {
	test("groups errors by code and enforcement, titled in a few words", () => {
		const paused = {
			code: "18940",
			message:
				"Your offer is paused because you cancelled multiple customer orders. To confirm that you want to sell it, reactivate it.",
			severity: "ERROR",
			categories: ["LISTING"],
			enforcements: { actions: [{ action: "LISTING_SUPPRESSED" }] },
		};
		const tooLong = (field: string) => ({
			code: "90225",
			message: `Value for '${field}' is longer than the allowed maximum (15 characters).`,
			severity: "ERROR",
			categories: ["INVALID_ATTRIBUTE", "PRODUCT"],
		});
		const problems = amazonIssueProblems([
			listing("A1", [paused]),
			listing("A2", [paused, tooLong("Blade"), tooLong("Edge")]),
			listing("A3", [
				tooLong("Handle"),
				{
					code: "1",
					message: "Something Amazon hasn't said before.",
					severity: "ERROR",
					categories: ["INVALID_IMAGE", "PRODUCT"],
				},
				// A suggestion, not a problem.
				{ code: "101265", message: "Try FBA.", severity: "WARNING" },
			]),
		]);
		expect(problems).toEqual([
			{
				level: "at_risk",
				text: "Listing suppressed: Paused after cancelled orders",
				href: expect.stringContaining("sellercentral"),
				detail: paused.message,
				items: [
					expect.objectContaining({ listingId: "A1", label: "Item A1" }),
					expect.objectContaining({ listingId: "A2" }),
				],
			},
			{
				level: "watch",
				text: "A value is too long",
				href: expect.any(String),
				detail: null,
				items: [
					expect.objectContaining({
						ref: "A2",
						// Both of its errors, on one row.
						detail: `${tooLong("Blade").message} ${tooLong("Edge").message}`,
						href: expect.stringContaining("searchTerm=A2"),
					}),
					expect.objectContaining({ ref: "A3" }),
				],
			},
			// A code we haven't named reads as Amazon's category.
			expect.objectContaining({
				text: "Invalid image",
				detail: "Something Amazon hasn't said before.",
			}),
		]);
		// Every listing says the same, so it's said once, on the problem.
		expect(problems[0].items.map((i) => i.detail)).toEqual([null, null]);
	});
});
