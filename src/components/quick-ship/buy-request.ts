import type { quickShipBuy } from "#/server/shipping";
import type { ShipmentPlan } from "#/shipping/quick-ship";
import type { Rate } from "#/shipping/shippo";
import { splitInsurance } from "./insurance";
import { setsDefault } from "./packaging";
import type { Extras, Packed } from "./types";

// What buying `quote` for these boxes sends, at the price on screen.
export function buyRequest(
	plan: ShipmentPlan,
	list: Packed[],
	extras: Extras,
	newDefault: boolean,
	quote: Rate,
): Parameters<typeof quickShipBuy>[0]["data"] {
	const parts = splitInsurance(extras.insure, list.length);
	return {
		orderIds: plan.orderIds,
		contentsKey: plan.contentsKey,
		signature: extras.signature,
		setsDefault: setsDefault(plan, list, newDefault),
		boxes: list.map((p, i) => ({
			packageId: p.box?.id ?? null,
			...p.dims,
			weightGrams: p.weightGrams,
			insureAmount: parts[i],
			hazmat: p.hazmat,
		})),
		choice: {
			carrier: quote.carrier,
			service: quote.service,
			id: quote.id,
			total: quote.cost,
		},
	};
}
