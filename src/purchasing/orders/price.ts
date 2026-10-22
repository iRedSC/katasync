import { PurchaseOrderError } from "./lock";

// A line's price per unit, when it has one, is never negative. Every write of
// a price goes through this, including restoring a deleted draft, so a
// snapshot can't put back what a new line would refuse.
export function checkPrice(unitCost: number | null | undefined) {
	if (unitCost != null && !(unitCost >= 0))
		throw new PurchaseOrderError(`Price can't be ${unitCost}`);
}
