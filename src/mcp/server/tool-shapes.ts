import { z } from "zod";
import type { DiscountOff } from "#/purchasing/discount";
import { PurchaseOrderError } from "#/purchasing/orders";

// What tools return, their annotations, and input shapes several tools share.
export const json = (data: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }],
});

export const READ = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	openWorldHint: false,
} as const;

export const unitTerms = {
	unit: z.string().describe("Purchase unit name, e.g. EACH or CASE"),
	pack_size: z
		.number()
		.int()
		.positive()
		.describe("How many of the product one unit holds; 1 for EACH"),
	supplier_count: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"How many the supplier says one unit holds, printed on the PO. Defaults to pack_size; differs when their count isn't ours, e.g. their PACK of 5 is one of our product (pack_size 1, supplier_count 5)",
		),
	minimum: z
		.number()
		.int()
		.positive()
		.describe("Fewest units the supplier sells"),
};

export const boxShape = {
	name: z.string().optional().describe("Defaults to its size, e.g. 3 × 3 × 6"),
	length_in: z.number().positive(),
	width_in: z.number().positive(),
	height_in: z.number().positive(),
	weight_oz: z.number().min(0).describe("The empty box"),
};

// A percent or an amount, exactly one.
export const discountShape = {
	percent: z
		.number()
		.gt(0)
		.max(100)
		.optional()
		.describe("Percent off, e.g. 10; 100 is free. Give this or amount"),
	amount: z
		.number()
		.positive()
		.optional()
		.describe(
			"Dollars off those units together, not each. Give this or percent",
		),
};

export function offOf(d: { percent?: number; amount?: number }): DiscountOff {
	if ((d.percent === undefined) === (d.amount === undefined))
		throw new PurchaseOrderError("Give a percent or an amount, not both");
	return d.percent !== undefined
		? { kind: "percent", percent: d.percent }
		: { kind: "amount", amount: d.amount ?? 0 };
}
