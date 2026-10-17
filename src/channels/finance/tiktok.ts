// Pure parsing and allocation of TikTok Shop statement transactions.
// Network calls and signing live in src/channels/tiktok.ts.

export const TIKTOK_ESTIMATED_FEE_LABEL = "Referral Fee (Estimated 6%)";
export const TIKTOK_ESTIMATED_FEE_RATE = 0.06;

export type CostBreakdown = Array<[string, number] | Array<string | number>>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// TikTok sends some ids as JSON numbers; large ones lose precision there, so ids are read as strings.
export function tiktokString(value: unknown): string {
	if (typeof value === "string" && value.trim() !== "") {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return "";
}

export type SkuFinance = {
	skuId: string;
	quantity: number;
	fees: number;
	feesBreakdown: CostBreakdown;
	shipping: number;
	shippingBreakdown: CostBreakdown;
	buyerPaidShipping: number;
};

export type TiktokFinanceStatus = "estimated" | "unsettled" | "settled";

export function isTiktokShippingEstimated(
	financeStatus: TiktokFinanceStatus,
	financeShippingTotal: number,
): boolean {
	return financeStatus !== "settled" && financeShippingTotal === 0;
}

// Affiliate commission lines are paid out separately and would double-count the fee.
const SKIP_FEE_KEYS = new Set([
	"affiliate_commission_amount_before_pit",
	"affiliate_commission_before_pit_amount",
	"affiliate_commission_deposit",
	"affiliate_commission_release",
]);

// Buyer-side taxes and delivery fees are collected for the government, not earned or spent by the seller.
const BUYER_TAX_KEYS = new Set([
	"sales_tax_amount",
	"sales_tax_payment_amount",
	"sales_tax_refund_amount",
	"tax_sales_tax_amount",
	"tax_sales_tax_payment_amount",
	"tax_sales_tax_refund_amount",
	"retail_delivery_fee_amount",
	"retail_delivery_fee_payment_amount",
	"retail_delivery_fee_refund_amount",
]);

const CUSTOMER_PAID_SHIPPING_KEYS = new Set([
	"customer_paid_shipping_fee_amount",
]);

export function parseSignedAmount(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	if (isRecord(value) && "amount" in value) {
		return parseSignedAmount(value.amount);
	}
	return 0;
}

function paymentFromOrder(order: unknown): Record<string, unknown> | undefined {
	if (!isRecord(order)) return undefined;
	return isRecord(order.payment)
		? order.payment
		: isRecord(order.payment_info)
			? order.payment_info
			: undefined;
}

export function buyerPaidShippingFromOrder(order: unknown): number | undefined {
	const payment = paymentFromOrder(order);
	if (!payment || !("shipping_fee" in payment)) return undefined;
	return Math.max(0, parseSignedAmount(payment.shipping_fee));
}

export function estimatedShippingFromOrder(order: unknown): number | undefined {
	const payment = paymentFromOrder(order);
	if (!payment || !("original_shipping_fee" in payment)) return undefined;
	return Math.max(0, parseSignedAmount(payment.original_shipping_fee));
}

function feeLabel(key: string): string {
	return key.replace(/_amount$/u, "");
}

function collectChargeBreakdown(
	source: unknown,
	skip: (key: string) => boolean,
): CostBreakdown {
	if (!isRecord(source)) {
		return [];
	}

	const breakdown: CostBreakdown = [];
	for (const [key, value] of Object.entries(source)) {
		if (key === "supplementary_component" || skip(key)) {
			continue;
		}
		const amount = Math.abs(parseSignedAmount(value));
		if (amount > 0) {
			breakdown.push([feeLabel(key), amount]);
		}
	}
	return breakdown;
}

function parseSkuTransaction(raw: unknown): SkuFinance | null {
	if (!isRecord(raw)) {
		return null;
	}

	const skuId = typeof raw.sku_id === "string" && raw.sku_id ? raw.sku_id : "";
	const quantity = Math.max(
		1,
		Math.trunc(parseSignedAmount(raw.quantity) || 1),
	);

	const feeTax = isRecord(raw.fee_tax_breakdown) ? raw.fee_tax_breakdown : {};
	const feesBreakdown = [
		...collectChargeBreakdown(
			feeTax.fee,
			(key) => SKIP_FEE_KEYS.has(key) || BUYER_TAX_KEYS.has(key),
		),
		...collectChargeBreakdown(feeTax.tax, (key) => BUYER_TAX_KEYS.has(key)),
	];
	const fees = feesBreakdown.reduce(
		(sum, [, amount]) => sum + (typeof amount === "number" ? amount : 0),
		0,
	);

	const shippingSource = isRecord(raw.shipping_cost_breakdown)
		? raw.shipping_cost_breakdown
		: {};
	let buyerPaidShipping = 0;
	let sellerShippingSigned = 0;
	const shippingBreakdown: CostBreakdown = [];

	for (const [key, value] of Object.entries(shippingSource)) {
		if (key === "supplementary_component") {
			continue;
		}
		const signed = parseSignedAmount(value);
		if (CUSTOMER_PAID_SHIPPING_KEYS.has(key)) {
			buyerPaidShipping += Math.abs(signed);
			continue;
		}
		sellerShippingSigned += signed;
		const abs = Math.abs(signed);
		if (abs > 0) {
			shippingBreakdown.push([feeLabel(key), abs]);
		}
	}

	return {
		skuId,
		quantity,
		fees,
		feesBreakdown,
		shipping: Math.max(0, -sellerShippingSigned),
		shippingBreakdown,
		buyerPaidShipping,
	};
}

function skuTransactionsFromPayload(payload: unknown): unknown[] {
	if (!isRecord(payload)) {
		return [];
	}
	if (Array.isArray(payload.sku_transactions)) {
		return payload.sku_transactions;
	}
	if (Array.isArray(payload.transactions)) {
		return payload.transactions;
	}
	if (isRecord(payload.data)) {
		return skuTransactionsFromPayload(payload.data);
	}
	return [];
}

/**
 * Parse Get Order Statement Transactions (`/finance/202501/orders/{id}/statement_transactions`).
 * Falls back to a single order-level row when SKU splits are absent.
 */
export function parseOrderFinance(payload: unknown): SkuFinance[] {
	const skuRows = skuTransactionsFromPayload(payload)
		.map(parseSkuTransaction)
		.filter((row): row is SkuFinance => row !== null);

	if (skuRows.length > 0) {
		return skuRows;
	}

	const data = isRecord(payload)
		? isRecord(payload.data)
			? payload.data
			: payload
		: null;
	if (!data) {
		return [];
	}

	if (!data.fee_tax_breakdown && !data.shipping_cost_breakdown) {
		return [];
	}

	const orderRow = parseSkuTransaction(data);
	return orderRow ? [orderRow] : [];
}

export function estimatedReferralFinance(price: number): SkuFinance {
	const fees = price * TIKTOK_ESTIMATED_FEE_RATE;
	return {
		skuId: "",
		quantity: 1,
		fees,
		feesBreakdown: [[TIKTOK_ESTIMATED_FEE_LABEL, fees]],
		shipping: 0,
		shippingBreakdown: [],
		buyerPaidShipping: 0,
	};
}

export type LineItemFinanceShare = {
	fees: number;
	feesBreakdown: CostBreakdown;
	shipping: number;
	shippingBreakdown: CostBreakdown;
	buyerPaidShipping: number;
};

// Finance rows can disagree with the order's checkout total, so scale them to what the buyer actually paid.
export function reconcileBuyerPaidShipping(
	shares: LineItemFinanceShare[],
	quantities: number[],
	orderTotal: number | undefined,
): number[] {
	if (orderTotal === undefined) {
		return shares.map((share) => share.buyerPaidShipping);
	}

	const financeTotal = shares.reduce(
		(sum, share, index) =>
			sum + share.buyerPaidShipping * (quantities[index] ?? 0),
		0,
	);
	if (financeTotal > 0) {
		const scale = orderTotal / financeTotal;
		return shares.map((share) => share.buyerPaidShipping * scale);
	}

	const totalQuantity = quantities.reduce((sum, quantity) => sum + quantity, 0);
	return shares.map(() => orderTotal / Math.max(1, totalQuantity));
}

function scaleBreakdown(
	breakdown: CostBreakdown,
	factor: number,
): CostBreakdown {
	return breakdown.map(([label, amount]) => [
		label,
		(typeof amount === "number" ? amount : 0) * factor,
	]);
}

function perUnitShare(row: SkuFinance, units: number): LineItemFinanceShare {
	const divisor = Math.max(1, units);
	return {
		fees: row.fees / divisor,
		feesBreakdown: scaleBreakdown(row.feesBreakdown, 1 / divisor),
		shipping: row.shipping / divisor,
		shippingBreakdown: scaleBreakdown(row.shippingBreakdown, 1 / divisor),
		buyerPaidShipping: row.buyerPaidShipping / divisor,
	};
}

/**
 * Allocate statement-transaction totals onto sold units.
 * SKU rows split across units of that sku_id; a single order-level row splits across every unit.
 */
export function allocateFinanceToUnits(
	lineItems: Array<{ skuId: string; quantity: number; price: number }>,
	financeRows: SkuFinance[],
): LineItemFinanceShare[] {
	const totalUnits = lineItems.reduce((sum, item) => sum + item.quantity, 0);
	const hasSkuRows = financeRows.some((row) => row.skuId);
	const orderLevelRow =
		!hasSkuRows && financeRows.length === 1 ? financeRows[0] : undefined;

	const unitsBySku = new Map<string, number>();
	for (const item of lineItems) {
		unitsBySku.set(
			item.skuId,
			(unitsBySku.get(item.skuId) ?? 0) + item.quantity,
		);
	}

	return lineItems.map((item) => {
		if (orderLevelRow) {
			return perUnitShare(orderLevelRow, Math.max(1, totalUnits));
		}

		const skuRow = financeRows.find(
			(row) => row.skuId && row.skuId === item.skuId,
		);
		if (skuRow) {
			return perUnitShare(
				skuRow,
				Math.max(1, unitsBySku.get(item.skuId) ?? item.quantity),
			);
		}

		return perUnitShare(estimatedReferralFinance(item.price), 1);
	});
}
