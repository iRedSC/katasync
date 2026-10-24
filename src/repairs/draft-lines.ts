import { createHash } from "node:crypto";
import type { DraftLine } from "#/channels/shopify/draft-orders";
import { type LaborVariant, splitLabor } from "./labor";

// The lines of a repair's draft order. katasync owns the ones it marks with
// a hidden "_repair" property (the labor and the parts) and rewrites them on
// every change. Anything else on the draft was added in Shopify (at the
// register, say) and is sent back as it was, so a change here never drops a
// sale made there.

export const REPAIR_KEY = "_repair";

export const isOurs = (line: Pick<DraftLine, "customAttributes">) =>
	line.customAttributes.some((a) => a.key === REPAIR_KEY);

// The same line, as Shopify takes it, keeping everything set on it there.
export function replay(line: DraftLine): Record<string, unknown> {
	const discount = line.appliedDiscount && {
		value: line.appliedDiscount.value,
		valueType: line.appliedDiscount.valueType,
		...(line.appliedDiscount.title && { title: line.appliedDiscount.title }),
		...(line.appliedDiscount.description && {
			description: line.appliedDiscount.description,
		}),
	};
	return {
		uuid: line.uuid,
		quantity: line.quantity,
		customAttributes: line.customAttributes.map((a) => ({
			key: a.key,
			value: a.value ?? "",
		})),
		...(discount && { appliedDiscount: discount }),
		...(line.priceOverride && { priceOverride: line.priceOverride }),
		...(line.variant && !line.custom
			? { variantId: line.variant.id }
			: {
					title: line.title,
					originalUnitPriceWithCurrency: {
						amount: line.originalUnitPriceSet.shopMoney.amount,
						currencyCode: line.priceOverride?.currencyCode ?? "USD",
					},
					taxable: line.taxable,
					requiresShipping: line.requiresShipping,
					...(line.sku && { sku: line.sku }),
					...(line.weight && { weight: line.weight }),
				}),
	};
}

// A line's uuid, the same every time for the same repair and variant, as
// Shopify asks.
export function lineUuid(repairId: number, variantId: string) {
	const h = createHash("sha256")
		.update(`repair:${repairId}:${variantId}`)
		.digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type Charges = {
	repairId: number;
	laborMinutes: number;
	parts: { variantId: string; quantity: number }[];
};

export class LaborSplitError extends Error {}

// The repair's own lines: all its time as the fewest labor variants, then
// its parts.
export function ourLines(c: Charges, variants: readonly LaborVariant[]) {
	const split = c.laborMinutes > 0 ? splitLabor(c.laborMinutes, variants) : [];
	if (!split)
		throw new LaborSplitError(
			"Shopify's labor variants can't add up to that much time",
		);
	const counts = new Map<string, number>();
	for (const v of split)
		counts.set(v.variantId, (counts.get(v.variantId) ?? 0) + 1);
	for (const p of c.parts)
		counts.set(p.variantId, (counts.get(p.variantId) ?? 0) + p.quantity);
	const name = `R${c.repairId}`;
	return [...counts].map(([variantId, quantity]) => ({
		uuid: lineUuid(c.repairId, variantId),
		variantId,
		quantity,
		customAttributes: [{ key: REPAIR_KEY, value: name }],
	}));
}

// Every line the draft should have: what was added in Shopify, then ours.
export const draftLines = (
	existing: readonly DraftLine[],
	ours: ReturnType<typeof ourLines>,
) => [...existing.filter((l) => !isOurs(l)).map(replay), ...ours];
