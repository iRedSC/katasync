import { useRef } from "react";
import {
	quickShipLookup,
	quickShipPlan,
	quickShipRates,
} from "#/server/shipping";
import type { ShipmentPlan } from "#/shipping/quick-ship";
import { splitInsurance } from "./insurance";
import type { Extras, Found, Packed, Rates } from "./types";

// The per-open caches of lookups, plans, and prices. priceFor prices the
// given plan, so it reads the plan from this render.
export function useQuickShipCache(plan: ShipmentPlan | null) {
	const lookups = useRef(new Map<number, Promise<Found | null>>());
	const plans = useRef(new Map<string, Promise<ShipmentPlan>>());
	const priced = useRef(new Map<string, Promise<Rates>>());

	function clear() {
		lookups.current.clear();
		plans.current.clear();
		priced.current.clear();
	}

	function clearPrices() {
		priced.current.clear();
	}

	function lookUp(pin: number) {
		let pending = lookups.current.get(pin);
		if (!pending) {
			pending = quickShipLookup({ data: { pin } });
			pending.catch(() => lookups.current.delete(pin));
			lookups.current.set(pin, pending);
		}
		return pending;
	}

	function planFor(orderIds: number[]) {
		const key = orderIds.join(",");
		let pending = plans.current.get(key);
		if (!pending) {
			pending = quickShipPlan({ data: { orderIds } });
			pending.catch(() => plans.current.delete(key));
			plans.current.set(key, pending);
		}
		return pending;
	}

	function priceFor(list: Packed[], extras: Extras) {
		if (!plan || list.length === 0) return null;
		const parts = splitInsurance(extras.insure, list.length);
		const data = {
			orderIds: plan.orderIds,
			contentsKey: plan.contentsKey,
			signature: extras.signature,
			boxes: list.map((p, i) => ({
				packageId: p.box?.id ?? null,
				...p.dims,
				weightGrams: p.weightGrams,
				insureAmount: parts[i],
			})),
		};
		const key = JSON.stringify(data);
		let pending = priced.current.get(key);
		if (!pending) {
			pending = quickShipRates({ data }).then((r) => ({
				list: r.rates,
				notes: r.notes,
				test: r.test,
			}));
			pending.catch(() => priced.current.delete(key));
			priced.current.set(key, pending);
		}
		return pending;
	}

	return { clear, clearPrices, lookUp, planFor, priceFor };
}
