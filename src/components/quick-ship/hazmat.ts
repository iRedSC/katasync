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
