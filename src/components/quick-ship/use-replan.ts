import type { Lowered } from "#/shipping/packed";
import type { ShipmentPlan } from "#/shipping/quick-ship";
import type { Found } from "./types";

// Changing what's in the box while choosing the first box: other orders to
// the same address joining or leaving, or a line's count lowered (the rest
// stays on To ship). Only then: the contents decide the boxes. Each change
// asks for the new plan, and onPlan starts over from it, so the box,
// weight, prices, and insurance are never for the old contents.
export function useReplan({
	found,
	plan,
	ready,
	run,
	planFor,
	onPlan,
}: {
	found: Found | null;
	plan: ShipmentPlan | null;
	// On the first box's step, with nothing loading.
	ready: boolean;
	run: <T>(work: () => Promise<T>) => Promise<T | undefined>;
	planFor: (orderIds: number[], lowered: Lowered) => Promise<ShipmentPlan>;
	onPlan: (next: ShipmentPlan) => void;
}) {
	async function replan(orderIds: number[], lowered: Lowered) {
		const next = await run(() => planFor(orderIds, lowered));
		if (next) onPlan(next);
	}

	// Adds or removes one other order, or all of them. Counts lowered on the
	// orders still in the box are kept.
	function toggleCompanion(id?: number) {
		if (!found || !plan || !ready) return;
		const chosen = new Set(plan.orderIds.slice(1));
		const ids = id === undefined ? found.companions.map((c) => c.id) : [id];
		const adding = ids.some((i) => !chosen.has(i));
		for (const i of ids) adding ? chosen.add(i) : chosen.delete(i);
		const orderIds = [
			found.order.id,
			...found.companions.map((c) => c.id).filter((i) => chosen.has(i)),
		];
		const kept = new Set(
			plan.choices
				.filter((c) => orderIds.includes(c.orderId))
				.map((c) => c.orderLineId),
		);
		return replan(
			orderIds,
			plan.lowered.filter((l) => kept.has(l.orderLineId)),
		);
	}

	// Sends this many of a line now, from 0 to all that's packable.
	function setCount(orderLineId: number, quantity: number) {
		if (!plan || !ready) return;
		const line = plan.choices.find((c) => c.orderLineId === orderLineId);
		if (!line || quantity < 0 || quantity > line.packable) return;
		if (quantity === line.quantity) return;
		// Something has to go in the box.
		const going = plan.choices.reduce((n, c) => n + c.quantity, 0);
		if (going - line.quantity + quantity === 0) return;
		const others = plan.lowered.filter((l) => l.orderLineId !== orderLineId);
		return replan(
			plan.orderIds,
			quantity === line.packable
				? others
				: [...others, { orderLineId, quantity }],
		);
	}

	return { toggleCompanion, setCount };
}
