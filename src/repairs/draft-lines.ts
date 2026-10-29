import { createHash } from "node:crypto";
import type { DraftLine } from "#/channels/shopify/draft-orders";
import { formatMinutes, type LaborVariant, splitLabor } from "./labor";

// The lines of a repair's draft order. katasync owns the ones it marks with
// a hidden "_repair" property (the repair's labor, each tool's parts, and
// the order's own) and rewrites them on every change. Anything else on the
// draft was added in Shopify (at the register, say) and is sent back as it
// was, so a change here never drops a sale made there.

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

// Which of the repair's tools one of our lines is for: its id, OTHER for
// what's on the order as a whole, or LABOR for the time on all of them,
// billed together so splitting it by tool never changes its price. Lines
// from before tools had ids say none, and are the repair's first tool's:
// it had only the one.
export const TOOL_KEY = "_repair_tool";
export const OTHER = "other";
export const LABOR = "labor";
// What the customer sees on the line, in Shopify's invoice too.
export const TOOL_LABEL = "Tool";

export const toolKey = (toolId: number | null) =>
	toolId === null ? OTHER : String(toolId);

// The tool key one of our lines is for.
export const lineTool = (
	line: Pick<DraftLine, "customAttributes">,
	firstToolId: number | undefined,
) =>
	line.customAttributes.find((a) => a.key === TOOL_KEY)?.value ??
	toolKey(firstToolId ?? null);

// A line's uuid, the same every time for the same repair, tool key, and
// variant, as Shopify asks.
export function lineUuid(repairId: number, key: string, variantId: string) {
	const h = createHash("sha256")
		.update(`repair:${repairId}:${key}:${variantId}`)
		.digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// What one tool, or the order as a whole (toolId null), is charged.
export type ChargeGroup = {
	toolId: number | null;
	// Shown on its lines: the tool and its serial.
	label: string | null;
	laborMinutes: number;
	parts: { variantId: string; quantity: number }[];
};

export type Charges = { repairId: number; groups: ChargeGroup[] };

export class LaborSplitError extends Error {}

// The repair's own lines: all its time together as the fewest labor
// variants, labeled with whose time it is, then each tool's parts.
export function ourLines(c: Charges, variants: readonly LaborVariant[]) {
	const minutes = c.groups.reduce((n, g) => n + g.laborMinutes, 0);
	const split = minutes > 0 ? splitLabor(minutes, variants) : [];
	if (!split)
		throw new LaborSplitError(
			"Shopify's labor variants can't add up to that much time",
		);
	const timed = c.groups.filter((g) => g.laborMinutes > 0);
	const whose =
		timed.length === 1
			? timed[0].label
			: timed
					.map((g) => `${g.label ?? "Other"} ${formatMinutes(g.laborMinutes)}`)
					.join(", ");
	const lines = (
		key: string,
		label: string | null,
		items: { variantId: string; quantity: number }[],
	) => {
		const counts = new Map<string, number>();
		for (const i of items)
			counts.set(i.variantId, (counts.get(i.variantId) ?? 0) + i.quantity);
		const customAttributes = [
			{ key: REPAIR_KEY, value: `R${c.repairId}` },
			{ key: TOOL_KEY, value: key },
			...(label ? [{ key: TOOL_LABEL, value: label }] : []),
		];
		return [...counts].map(([variantId, quantity]) => ({
			uuid: lineUuid(c.repairId, key, variantId),
			variantId,
			quantity,
			customAttributes,
		}));
	};
	return [
		...lines(
			LABOR,
			whose,
			split.map((v) => ({ variantId: v.variantId, quantity: 1 })),
		),
		...c.groups.flatMap((g) => lines(toolKey(g.toolId), g.label, g.parts)),
	];
}

// Every line the draft should have: what was added in Shopify, then ours.
export const draftLines = (
	existing: readonly DraftLine[],
	ours: ReturnType<typeof ourLines>,
) => [...existing.filter((l) => !isOurs(l)).map(replay), ...ours];
