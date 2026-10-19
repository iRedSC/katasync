// Why a buyer sent something back, as the marketplace says it, in one set
// of words, so the same reason reads (and counts) the same on every
// channel: a one- or two-word chip, and a sentence for where there's room.

type Reason = { chip: string; text: string };
const reason = (chip: string, text = chip): Reason => ({ chip, text });

const NOT_AS_DESCRIBED = reason("Misdescribed", "Not as described");
const WRONG_ITEM = reason("Wrong item", "Wrong item was sent");
const ORDERED_WRONG = reason("Ordered wrong", "Ordered the wrong item");
const UNWANTED = reason("Unwanted", "No longer wanted");
const DEFECTIVE = reason("Defective");
const MISSING_PARTS = reason("Missing parts");
const SHIPPING_DAMAGE = reason("Shipping damage", "Damaged in shipping");
const LATE = reason("Late", "Arrived late");
const TOO_LARGE = reason("Too large");
const TOO_SMALL = reason("Too small");
const POOR_FIT = reason("Poor fit");

const reasons: Record<string, Reason> = {
	// Amazon
	"AMZ-PG-BAD-DESC": NOT_AS_DESCRIBED,
	"AMZ-PG-APP-TOO-LARGE": TOO_LARGE,
	"AMZ-PG-APP-TOO-SMALL": TOO_SMALL,
	"CR-DEFECTIVE": DEFECTIVE,
	// Seller Central's own words for it. The buyer picks it when asking to
	// return, so it's their claim, not a warehouse finding that they sent
	// back a different item (the FBA report's plain SWITCHEROO).
	"CR-SWITCHEROO": WRONG_ITEM,
	"CR-UNAUTHORIZED_PURCHASE": reason("Unauthorized", "Unauthorized purchase"),
	"CR-UNWANTED_ITEM": UNWANTED,
	"CR-ORDERED_WRONG_ITEM": ORDERED_WRONG,
	"CR-NOT_COMPATIBLE": reason("Incompatible", "Not compatible"),
	"CR-MISSING_PARTS": MISSING_PARTS,
	"CR-DAMAGED_BY_CARRIER": SHIPPING_DAMAGE,
	"CR-MISSED_ESTIMATED_DELIVERY": LATE,
	POOR_FIT,
	// eBay
	DEFECTIVE_ITEM: DEFECTIVE,
	NOT_AS_DESCRIBED,
	DIFFERENT_FROM_LISTING: NOT_AS_DESCRIBED,
	WRONG_ITEM,
	ORDERED_WRONG_ITEM: ORDERED_WRONG,
	ORDERED_ACCIDENTALLY: reason("Accidental", "Ordered by mistake"),
	NO_LONGER_NEED_ITEM: UNWANTED,
	CHANGED_MIND: UNWANTED,
	FOUND_BETTER_PRICE: reason("Better price", "Found a better price"),
	MISSING_PARTS,
	ARRIVED_DAMAGED: SHIPPING_DAMAGE,
	ARRIVED_LATE: LATE,
	WRONG_SIZE: reason("Wrong size"),
	DOES_NOT_FIT: POOR_FIT,
	OTHER: reason("Other"),
	// Shopify names its reasons in words already; these say the same as the
	// others.
	"No longer needed": UNWANTED,
	"Changed my mind": UNWANTED,
	"Defective item": DEFECTIVE,
	"Item doesn't match description": NOT_AS_DESCRIBED,
	Incompatible: reason("Incompatible", "Not compatible"),
	Size: reason("Wrong size"),
	Unwanted: UNWANTED,
	"Not as described": NOT_AS_DESCRIBED,
	"Wrong item": WRONG_ITEM,
	"Received the wrong item": WRONG_ITEM,
	"Wrong item was sent": WRONG_ITEM,
	"Damaged or defective": reason("Damaged", "Damaged or defective"),
	"Returned to sender": reason("Undeliverable", "Returned to sender"),
	"Item Arrived Late": LATE,
	Defective: DEFECTIVE,
	"Missing parts": MISSING_PARTS,
	"Size too small": TOO_SMALL,
	// TikTok words its reasons too.
	"Product wouldn't arrive on time": LATE,
	"Missing package": reason("Lost package", "Package never arrived"),
	"Missing items": MISSING_PARTS,
	"Damaged item": reason("Damaged"),
	"Damaged item or packaging": reason("Damaged", "Damaged item or packaging"),
	"Item arrived too late": LATE,
	"Damaged product": reason("Damaged"),
	"Product doesn't match description": NOT_AS_DESCRIBED,
	"Wrong product": WRONG_ITEM,
	"Size too large": TOO_LARGE,
};

// A code not listed reads as the marketplace wrote it, its prefix and
// underscores dropped ("CR-SOME_REASON" as "Some reason"). Its chip keeps
// the first two words; hovering shows the rest. Add it above to name it well.
function unlisted(code: string): Reason {
	const words = code
		.replace(/^(CR|AMZ-PG)-/, "")
		.replace(/[_-]+/g, " ")
		.trim()
		.toLowerCase();
	const text = words.charAt(0).toUpperCase() + words.slice(1);
	const kept = text.split(" ");
	return reason(
		kept.length > 2 ? `${kept.slice(0, 2).join(" ")}…` : text,
		text,
	);
}

// A Shopify return of several items keeps each one's reason, joined by "; ".
export function returnReasons(raw: string): Reason[] {
	const found = raw
		.split("; ")
		.filter((code) => code.trim() !== "")
		.map((code) => reasons[code] ?? unlisted(code));
	return found.filter(
		(r, i) => found.findIndex((o) => o.chip === r.chip) === i,
	);
}

// The reason as a sentence, for where there's room.
export const returnReason = (raw: string) =>
	returnReasons(raw)
		.map((r) => r.text)
		.join("; ");
