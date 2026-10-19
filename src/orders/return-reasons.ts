// Why a buyer sent something back, as the marketplace says it.

// Amazon's codes, in plain words where their meaning is clear. Others show
// as Amazon wrote them.
const labels: Record<string, string> = {
	"AMZ-PG-BAD-DESC": "Not as described",
	"AMZ-PG-APP-TOO-LARGE": "Too large",
	"AMZ-PG-APP-TOO-SMALL": "Too small",
	"CR-DEFECTIVE": "Defective",
	// Seller Central's own words for it. The buyer picks it when asking to
	// return, so it's their claim, not a warehouse finding that they sent
	// back a different item (the FBA report's plain SWITCHEROO).
	"CR-SWITCHEROO": "Wrong item was sent",
	"CR-UNAUTHORIZED_PURCHASE": "Unauthorized purchase",
	"CR-UNWANTED_ITEM": "No longer wanted",
	"CR-ORDERED_WRONG_ITEM": "Ordered the wrong item",
	"CR-NOT_COMPATIBLE": "Not compatible",
	"CR-MISSING_PARTS": "Missing parts",
	"CR-DAMAGED_BY_CARRIER": "Damaged in shipping",
	"CR-MISSED_ESTIMATED_DELIVERY": "Arrived late",
	POOR_FIT: "Poor fit",
};
export const returnReason = (code: string) => labels[code] ?? code;
