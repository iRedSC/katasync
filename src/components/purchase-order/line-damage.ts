import type { PurchaseOrderDetail } from "#/server/purchasing";
import type { Line } from "./types";

export const lineName = (l: Pick<Line, "name" | "variantName">) =>
	l.variantName ? `${l.name} (${l.variantName})` : l.name;

// Single items of a line that arrived and aren't recorded as damaged yet.
export function damageable(d: PurchaseOrderDetail, l: Line) {
	const damaged = d.damages
		.filter((x) => x.lineId === l.id)
		.reduce((n, x) => n + x.quantity, 0);
	return Math.max(0, l.received * l.packSize - damaged);
}
