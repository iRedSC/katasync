import type { ShipmentPlan } from "#/shipping/quick-ship";
import type { Box, Dims, Packed } from "./types";

// A gross weight belongs to the packaging it was weighed in: the same saved
// box (none, for a custom one) at the same size. Any other packaging weighs
// something else, so the old weight is no default for it.
export function lastFor(
	plan: Pick<ShipmentPlan, "last">,
	index: number,
	box: Pick<Box, "id"> | null,
	dims: Dims,
) {
	const last = plan.last?.[index];
	if (!last) return null;
	const same =
		last.packageId === (box?.id ?? null) &&
		last.lengthMm === dims.lengthMm &&
		last.widthMm === dims.widthMm &&
		last.heightMm === dims.heightMm;
	return same ? last : null;
}

// The weight a box starts from: its gross weight last time in this packaging;
// else, for a single box with known items, the items plus the box's empty
// weight (none for a custom box); else nothing, so it's weighed.
export function startingGrams(
	plan: Pick<ShipmentPlan, "last" | "itemsWeightGrams">,
	index: number,
	box: Pick<Box, "id" | "weightGrams"> | null,
	dims: Dims,
) {
	const last = lastFor(plan, index, box, dims);
	if (last) return last.weightGrams;
	if (index > 0 || plan.itemsWeightGrams === null) return null;
	return plan.itemsWeightGrams + (box?.weightGrams ?? 0);
}

// Whether buying these boxes makes them the default for these contents:
// always when there's none yet or they match it (a fresher weight), else
// only when asked. A one-off box leaves the default alone.
export function setsDefault(
	plan: Pick<ShipmentPlan, "last">,
	list: Packed[],
	asked: boolean,
) {
	if (asked || !plan.last) return true;
	return (
		list.length === plan.last.length &&
		list.every((p, i) => lastFor(plan, i, p.box, p.dims) !== null)
	);
}
