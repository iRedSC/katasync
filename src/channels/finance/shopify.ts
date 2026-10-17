const SHOPIFYQL_PAGE_SIZE = 50;
const SHOPIFYQL_DEFAULT_SINCE = "2006-01-01";
const SHOPIFYQL_DAY_MS = 24 * 60 * 60 * 1000;
// Shop-local sale days can differ from the UTC order timestamp by a day, so
// the window reaches two days either side.
const SHOPIFYQL_TZ_PAD_DAYS = 2;

export type ShopifyOrderFinancials = {
	orderId: string;
	storeShippingCost: number;
	shippingLabelAdjustment: number;
	customerShippingCharges: number;
	shopifyPaymentsProcessingFees: number;
	foreignExchangeFees: number;
	managedMarketsFees: number;
	internationalFees: number;
};

export type ShopifyQlRow = Record<string, string | number | null>;

export type ShopifyBasicEvent = {
	action?: string;
	message?: string;
};

export function shopifyQlDateWindow(
	orderTimestamp: number,
	now = Date.now(),
): { startDate: string; endDate: string } {
	const start = new Date(
		orderTimestamp - SHOPIFYQL_TZ_PAD_DAYS * SHOPIFYQL_DAY_MS,
	);
	const end = new Date(
		Math.max(now, orderTimestamp) + SHOPIFYQL_TZ_PAD_DAYS * SHOPIFYQL_DAY_MS,
	);
	return {
		startDate: start.toISOString().slice(0, 10),
		endDate: end.toISOString().slice(0, 10),
	};
}

// Order IDs are interpolated into ShopifyQL, so they must be digits only.
function numericOrderIds(orderIds: string[]): string[] {
	return [...new Set(orderIds.map((id) => id.split("/").pop() ?? ""))].map(
		(id) => {
			if (!/^\d+$/.test(id)) {
				throw new Error(`Invalid Shopify order ID: ${id}`);
			}
			return id;
		},
	);
}

function queryLimit(orderIds?: string[]): number {
	if (!orderIds || orderIds.length === 0) return SHOPIFYQL_PAGE_SIZE;
	return Math.min(SHOPIFYQL_PAGE_SIZE, numericOrderIds(orderIds).length);
}

function limitClause(orderIds?: string[], offset?: number): string {
	const limit = queryLimit(orderIds);
	if (!offset) return `LIMIT ${limit}`;
	return `LIMIT ${limit} OFFSET ${offset}`;
}

function dateClause(startDate?: string, endDate?: string): string {
	if (!startDate && !endDate) {
		return `SINCE ${SHOPIFYQL_DEFAULT_SINCE} UNTIL today`;
	}
	if (!startDate || !endDate) {
		throw new Error("ShopifyQL date ranges require both a start and end date");
	}
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
		!/^\d{4}-\d{2}-\d{2}$/.test(endDate)
	) {
		throw new Error("ShopifyQL dates must use YYYY-MM-DD");
	}
	return `SINCE ${startDate} UNTIL ${endDate}`;
}

function orderClause(orderIds?: string[]): string {
	if (!orderIds || orderIds.length === 0) return "";
	return `WHERE order_id IN (${numericOrderIds(orderIds).join(", ")})`;
}

function buildQuery(args: {
	schema: "profitability" | "fees" | "shipping_labels";
	metrics: string[];
	startDate?: string;
	endDate?: string;
	orderIds?: string[];
	offset?: number;
}): string {
	return [
		`FROM ${args.schema}`,
		`SHOW ${args.metrics.join(", ")}`,
		orderClause(args.orderIds),
		"GROUP BY order_id",
		dateClause(args.startDate, args.endDate),
		"ORDER BY order_id ASC",
		limitClause(args.orderIds, args.offset),
	]
		.filter(Boolean)
		.join("\n");
}

export function buildShopifyProfitabilityQuery(args: {
	startDate?: string;
	endDate?: string;
	orderIds?: string[];
	offset?: number;
}): string {
	return buildQuery({
		schema: "profitability",
		metrics: [
			"average_store_shipping_costs",
			"average_shipping_label_adjustment_costs",
			"average_customer_shipping_charges",
		],
		...args,
	});
}

export function buildShopifyFeesQuery(args: {
	startDate?: string;
	endDate?: string;
	orderIds?: string[];
	offset?: number;
}): string {
	return buildQuery({
		schema: "fees",
		metrics: [
			"shopify_payments_processing_fees",
			"foreign_exchange_fees",
			"managed_markets_fees",
			"international_fees",
		],
		...args,
	});
}

export function buildShopifyShippingLabelsQuery(args: {
	startDate?: string;
	endDate?: string;
	orderIds?: string[];
	offset?: number;
}): string {
	return buildQuery({
		schema: "shipping_labels",
		metrics: ["shipping_label_costs"],
		...args,
	});
}

function money(row: ShopifyQlRow, key: string): number {
	const value = Number(row[key] ?? 0);
	return Number.isFinite(value) ? value : 0;
}

function orderId(row: ShopifyQlRow): string {
	const rawValue = String(row.order_id ?? "");
	const value = rawValue.split("/").pop() ?? "";
	if (!/^\d+$/.test(value)) {
		throw new Error(`Invalid order_id in ShopifyQL response: ${rawValue}`);
	}
	return value;
}

export function mergeShopifyFinancialRows(
	profitabilityRows: ShopifyQlRow[],
	feeRows: ShopifyQlRow[],
	shippingLabelRows: ShopifyQlRow[] = [],
): ShopifyOrderFinancials[] {
	const byOrder = new Map<string, ShopifyOrderFinancials>();

	const get = (id: string): ShopifyOrderFinancials => {
		const existing = byOrder.get(id);
		if (existing) return existing;
		const financials: ShopifyOrderFinancials = {
			orderId: id,
			storeShippingCost: 0,
			shippingLabelAdjustment: 0,
			customerShippingCharges: 0,
			shopifyPaymentsProcessingFees: 0,
			foreignExchangeFees: 0,
			managedMarketsFees: 0,
			internationalFees: 0,
		};
		byOrder.set(id, financials);
		return financials;
	};

	for (const row of profitabilityRows) {
		const financials = get(orderId(row));
		financials.storeShippingCost = money(row, "average_store_shipping_costs");
		financials.shippingLabelAdjustment = money(
			row,
			"average_shipping_label_adjustment_costs",
		);
		financials.customerShippingCharges = money(
			row,
			"average_customer_shipping_charges",
		);
	}

	for (const row of feeRows) {
		const financials = get(orderId(row));
		financials.shopifyPaymentsProcessingFees = money(
			row,
			"shopify_payments_processing_fees",
		);
		financials.foreignExchangeFees = money(row, "foreign_exchange_fees");
		financials.managedMarketsFees = money(row, "managed_markets_fees");
		financials.internationalFees = money(row, "international_fees");
	}

	// Label purchases are the real shipping cost, so they override the
	// profitability average whenever they exist.
	for (const row of shippingLabelRows) {
		const financials = get(orderId(row));
		const labelCost = money(row, "shipping_label_costs");
		if (labelCost !== 0) {
			financials.storeShippingCost =
				labelCost + financials.shippingLabelAdjustment;
		}
	}

	return [...byOrder.values()];
}

const LABEL_PURCHASE_COST =
	/purchased a \$([0-9,]+(?:\.[0-9]+)?)\s+shipping label/i;

export function shippingLabelCostFromEvents(
	events: ShopifyBasicEvent[],
): number {
	let total = 0;
	for (const event of events) {
		if (event.action !== "shipping_label_created_success") continue;
		const match = event.message?.match(LABEL_PURCHASE_COST);
		if (!match) continue;
		const amount = Number(match[1].split(",").join(""));
		if (Number.isFinite(amount)) total += amount;
	}
	return total;
}

// Event-logged label costs stand in when ShopifyQL has not caught up yet, and
// then the adjustment is folded in, since the event total is the full cost.
export function applyShippingLabelEvents<
	T extends {
		storeShippingCost: number;
		shippingLabelAdjustment: number;
	},
>(financials: T, events: ShopifyBasicEvent[]): T {
	const storeShippingCost = shippingLabelCostFromEvents(events);
	if (storeShippingCost === 0) return financials;
	return {
		...financials,
		storeShippingCost,
		shippingLabelAdjustment: 0,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function connectionNodes(value: unknown): unknown[] {
	if (!isRecord(value)) return [];
	if (Array.isArray(value.nodes)) return value.nodes;
	if (!Array.isArray(value.edges)) return [];
	return value.edges.map((edge) => (isRecord(edge) ? edge.node : undefined));
}

function methodTypeFromDelivery(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.methodType === "string" ? value.methodType : undefined;
}

function fulfillmentMethodTypes(order: unknown): string[] {
	if (!isRecord(order)) return [];
	const types: string[] = [];
	for (const node of connectionNodes(order.fulfillmentOrders)) {
		if (!isRecord(node)) continue;
		const methodType = methodTypeFromDelivery(node.deliveryMethod);
		if (methodType) types.push(methodType);
	}
	return types;
}

function normalizeDeliveryMethodType(value: string): string {
	return value.trim().toUpperCase().replace(/-/g, "_");
}

function isPickupMethodType(value: string): boolean {
	const normalized = normalizeDeliveryMethodType(value);
	return normalized === "PICK_UP" || normalized === "PICKUP";
}

function shippingLineLooksLikePickup(line: unknown): boolean {
	if (!isRecord(line)) return false;
	const fields = [
		line.deliveryCategory,
		line.code,
		line.title,
		line.shippingRateHandle,
	];
	return fields.some(
		(field) => typeof field === "string" && /\bpick[\s_-]?up\b/i.test(field),
	);
}

function shippingLinesLookLikePickup(order: unknown): boolean {
	if (!isRecord(order)) return false;
	const lines = connectionNodes(order.shippingLines);
	return lines.length > 0 && lines.every(shippingLineLooksLikePickup);
}

// Fulfillment method is authoritative when present. Shipping line names are
// only a fallback for orders without fulfillment orders.
export function isShopifyPickupOrder(order: unknown): boolean {
	const methodTypes = fulfillmentMethodTypes(order);
	if (methodTypes.length > 0) {
		return methodTypes.every(isPickupMethodType);
	}
	return shippingLinesLookLikePickup(order);
}
