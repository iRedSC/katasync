import type { ShipmentPlan } from "#/shipping/quick-ship";

// Whether a box starts marked as holding aerosols. When these contents
// shipped before with an aerosol box, last time says which boxes; else
// every box holding an aerosol product starts marked, since it isn't known
// which box the can went in. Ctrl+H changes it either way.
export function startsHazmat(
	plan: Pick<ShipmentPlan, "lines" | "last">,
	index: number,
) {
	if (plan.last?.some((b) => b.hazmat))
		return plan.last[index]?.hazmat ?? false;
	return plan.lines.some((l) => l.aerosol);
}

// A box's aerosol flag set by hand on the box step, and the contents it was
// set for. Other contents don't inherit it.
export type HazmatChoice = { contents: string; hazmat: boolean };

// Until the box step's choice is made, the contents decide (see startsHazmat).
export function hazmatFor(
	plan: Pick<ShipmentPlan, "lines" | "last" | "contentsKey"> | null,
	index: number,
	choice: HazmatChoice | null,
) {
	if (!plan) return false;
	return choice?.contents === plan.contentsKey
		? choice.hazmat
		: startsHazmat(plan, index);
}
