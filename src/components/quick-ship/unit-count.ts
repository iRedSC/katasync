import type { ShipmentPlan } from "#/shipping/quick-ship";

type Choice = Pick<
	ShipmentPlan["choices"][number],
	"orderId" | "quantity" | "packable" | "whole"
>;

// Where a line's buttons take its count: one unit at a time, or for a line
// that ships whole (eBay), all of it to none and back. Null where a button
// can't go: below 0, above what's packable, or taking out an order's last
// unit in the box (untick the order to leave it out instead).
export function countSteps(line: Choice, choices: Choice[]) {
	const going = choices
		.filter((c) => c.orderId === line.orderId)
		.reduce((n, c) => n + c.quantity, 0);
	const lower = line.whole ? 0 : line.quantity - 1;
	const raise = line.whole ? line.packable : line.quantity + 1;
	return {
		lower:
			line.quantity > 0 && going - (line.quantity - lower) > 0 ? lower : null,
		raise: line.quantity < line.packable ? raise : null,
	};
}
