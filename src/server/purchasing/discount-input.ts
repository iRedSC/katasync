import { type } from "arktype";

// A discount as the browser sends it; its limits are checked where it's saved.
const discountOff = type({ kind: "'percent'", percent: "number" }).or({
	kind: "'amount'",
	amount: "number",
});
export const discount = type({
	units: "number.integer > 0 | 'rest'",
	off: discountOff,
});
// One that came with a delivery, on some of what arrived (all of it without units).
export const receiptDiscount = type({
	"units?": "number.integer > 0",
	off: discountOff,
});
