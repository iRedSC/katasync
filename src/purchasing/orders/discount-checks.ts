import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	products,
	purchaseOrderDiscounts,
	purchaseOrderLines,
} from "#/db/schema";
import type { Discount, DiscountOff } from "#/purchasing/discount";
import { discountOf, discountProblem } from "#/purchasing/discount";
import { PurchaseOrderError } from "./lock";

// Whole cents and hundredths of a percent, as stored, so nothing is rounded
// away unseen.
export function checkOff(off: DiscountOff) {
	const exact = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
	if (off.kind === "percent" && !(off.percent > 0 && off.percent <= 100))
		throw new PurchaseOrderError(
			`A percent off is more than 0 and at most 100, got ${off.percent}`,
		);
	if (off.kind === "amount" && !(off.amount > 0))
		throw new PurchaseOrderError(
			`An amount off is more than $0, got ${off.amount}`,
		);
	if (!exact(off.kind === "percent" ? off.percent : off.amount))
		throw new PurchaseOrderError(
			off.kind === "percent"
				? `A percent off has at most 2 decimals, got ${off.percent}`
				: `An amount off is in whole cents, got ${off.amount}`,
		);
}

// Discounts in force on these lines, oldest first.
export async function lineDiscounts(tx: Db, lineIds: number[]) {
	if (lineIds.length === 0) return [];
	const rows = await tx
		.select({
			id: purchaseOrderDiscounts.id,
			lineId: purchaseOrderDiscounts.lineId,
			units: purchaseOrderDiscounts.units,
			percent: purchaseOrderDiscounts.percent,
			amount: purchaseOrderDiscounts.amount,
			receiptId: purchaseOrderDiscounts.receiptId,
			sent: purchaseOrderDiscounts.sent,
		})
		.from(purchaseOrderDiscounts)
		.where(
			and(
				inArray(purchaseOrderDiscounts.lineId, lineIds),
				isNull(purchaseOrderDiscounts.removedAt),
			),
		)
		.orderBy(purchaseOrderDiscounts.id);
	return rows.map(discountOf);
}

// Refuses discounts the line can't have as it now is (discountProblem), with
// `adding` among them when given. Every change to a line's quantity, price,
// or discounts goes through this inside its transaction. Returns the
// discounts in force.
export async function checkDiscounts(
	tx: Db,
	lineId: number,
	adding?: Discount,
) {
	const [line] = await tx
		.select({
			quantity: purchaseOrderLines.quantity,
			unitCost: purchaseOrderLines.unitCost,
			sku: products.sku,
			kind: products.kind,
		})
		.from(purchaseOrderLines)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.where(eq(purchaseOrderLines.id, lineId));
	// Taken off, discounts and all.
	if (!line) return [];
	const discounts = await lineDiscounts(tx, [lineId]);
	const all: Discount[] = adding ? [...discounts, adding] : discounts;
	if (all.length === 0) return discounts;
	if (line.kind === "bundle")
		throw new PurchaseOrderError(
			`${line.sku} is a tool set, priced as its parts; discount those`,
		);
	const problem = discountProblem(line, all);
	if (problem) throw new PurchaseOrderError(`${line.sku}: ${problem}`);
	return discounts;
}
