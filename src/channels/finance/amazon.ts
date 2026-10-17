import { MARKETPLACE_US } from "../amazon-api";

// Takes an SP-API path with its query string already attached, returns parsed JSON.
// Matches spApi() in amazon-api.ts, so tests can stub it.
export type SpApiGet = (path: string) => Promise<unknown>;

const AMAZON_FINANCE_V2024_REVIEW_AGE_DAYS = 7;
const AMAZON_SHIPMENT_EVENT_LISTS = [
	"ShipmentEventList",
	"ShipmentSettleEventList",
	"TrialShipmentEventList",
] as const;

type AmazonCurrencyAmount = {
	CurrencyAmount?: string | number;
};

type AmazonFeeComponent = {
	FeeType?: string;
	FeeName?: string;
	FeeAmount?: AmazonCurrencyAmount;
};

type AmazonShipmentItem = {
	SellerSKU?: string;
	ItemFeeList?: AmazonFeeComponent[];
};

type AmazonShipmentLikeEvent = {
	AmazonOrderId?: string;
	PostedDate?: string;
	ShipmentDate?: string;
	ShipmentItemList?: AmazonShipmentItem[];
	OrderFeeList?: AmazonFeeComponent[];
};

type AmazonShipmentLikeEventMatch = {
	listName: string;
	event: AmazonShipmentLikeEvent;
};

export type AmazonAdjustmentEvent = {
	AdjustmentType?: string;
	AdjustmentAmount?: AmazonCurrencyAmount;
	PostedDate?: string;
};

export type AmazonFinancialEvents = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

// Empty strings count as absent, so `??` can fall through to the next key.
function asString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

// Builds the query string by hand so values are always percent-encoded.
// Absent values are left out, as an unset NextToken must be.
function withQuery(path: string, query: Record<string, string | undefined>) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined) {
			params.set(key, value);
		}
	}
	return `${path}?${params}`;
}

function parseApiFloat(value: string | number | undefined): number {
	return parseFloat((value || "0") as string);
}

export function mergeFinancialEvents(
	target: Record<string, unknown>,
	source: Record<string, unknown> | null | undefined,
) {
	if (!source) {
		return;
	}

	for (const [key, value] of Object.entries(source)) {
		if (Array.isArray(value)) {
			target[key] = [...((target[key] as unknown[]) || []), ...value];
		} else if (target[key] === undefined) {
			target[key] = value;
		}
	}
}

export async function fetchFinancialEventsForOrder(
	spApi: SpApiGet,
	orderId: string,
) {
	const mergedFinancialEvents: AmazonFinancialEvents = {};
	let nextToken: string | undefined;
	let pagesFetched = 0;

	do {
		const financialResponse = asRecord(
			await spApi(
				withQuery(
					`/finances/v0/financialEventsByOrderId/${encodeURIComponent(orderId)}`,
					{ MaxResultsPerPage: "100", NextToken: nextToken },
				),
			),
		);

		pagesFetched++;
		mergeFinancialEvents(
			mergedFinancialEvents,
			asRecord(financialResponse?.FinancialEvents),
		);
		nextToken =
			asString(financialResponse?.NextToken) ??
			asString(financialResponse?.nextToken);
	} while (nextToken);

	return {
		financialEvents:
			Object.keys(mergedFinancialEvents).length > 0
				? mergedFinancialEvents
				: null,
		pagesFetched,
	};
}

type AmazonTransactionBreakdown = {
	breakdownType?: string;
	breakdownAmount?: { currencyAmount?: number | string };
	breakdowns?: AmazonTransactionBreakdown[] | null;
};

type AmazonTransaction = {
	transactionType?: string;
	transactionStatus?: string;
	postedDate?: string;
	relatedIdentifiers?: Array<{
		relatedIdentifierName?: string;
		relatedIdentifierValue?: string;
	}>;
	items?: Array<{
		breakdowns?: AmazonTransactionBreakdown[] | null;
		contexts?: Array<{ sku?: string; quantityShipped?: number }>;
	}>;
};

// Amazon defers payment on many orders until 7 days after delivery (DD7).
// Finances v0 omits deferred orders entirely until release, which can take
// two weeks or more. Finances 2024-06-19 returns them as soon as Amazon posts
// the shipment, so it is the only way to get fees for recent FBA orders.
export async function fetchTransactionsForOrder(
	spApi: SpApiGet,
	orderId: string,
) {
	const transactions: AmazonTransaction[] = [];
	let nextToken: string | undefined;

	do {
		const response = asRecord(
			await spApi(
				withQuery("/finances/2024-06-19/transactions", {
					relatedIdentifierName: "ORDER_ID",
					relatedIdentifierValue: orderId,
					nextToken,
				}),
			),
		);

		transactions.push(
			...((response?.transactions || []) as AmazonTransaction[]),
		);
		nextToken = asString(response?.nextToken);
	} while (nextToken);

	return transactions;
}

/**
 * Converts 2024-06-19 Shipment transactions into v0-shaped ShipmentEventList
 * entries so the rest of the import reads them like any other shipment event.
 *
 * A deferred order produces two transactions once released: the original
 * (DEFERRED_RELEASED, posted at shipment) and its release (RELEASED, carrying
 * a DEFERRED_TRANSACTION_ID). Both describe the same money, so the release
 * copy is dropped and the original's shipment-time posting date is kept.
 */
export function transactionsToShipmentEvents(
	transactions: AmazonTransaction[],
	orderId: string,
): AmazonShipmentLikeEvent[] {
	return transactions
		.filter(
			(transaction) =>
				transaction.transactionType === "Shipment" &&
				!transaction.relatedIdentifiers?.some(
					(identifier) =>
						identifier.relatedIdentifierName === "DEFERRED_TRANSACTION_ID",
				),
		)
		.map((transaction) => ({
			AmazonOrderId: orderId,
			PostedDate: transaction.postedDate,
			ShipmentItemList: (transaction.items || []).map((item) => {
				const amazonFees = (item.breakdowns || []).find(
					(breakdown) => breakdown.breakdownType === "AmazonFees",
				);
				return {
					SellerSKU: item.contexts?.find((context) => context.sku)?.sku,
					ItemFeeList: (amazonFees?.breakdowns || []).map((fee) => ({
						FeeType: fee.breakdownType,
						FeeAmount: {
							CurrencyAmount: fee.breakdownAmount?.currencyAmount,
						},
					})),
				};
			}),
		}));
}

export function getEventListCounts(
	financialEvents: AmazonFinancialEvents | null | undefined,
): Array<{ listName: string; count: number }> {
	if (!financialEvents) {
		return [];
	}

	return Object.entries(financialEvents)
		.filter(([key, value]) => key.endsWith("EventList") && Array.isArray(value))
		.map(([listName, value]) => ({
			listName,
			count: (value as unknown[]).length,
		}));
}

export function getShipmentLikeEvents(
	financialEvents: AmazonFinancialEvents | null | undefined,
	orderId: string,
) {
	const matchedEvents: AmazonShipmentLikeEventMatch[] = [];

	for (const listName of AMAZON_SHIPMENT_EVENT_LISTS) {
		const eventList = financialEvents?.[listName];
		if (!Array.isArray(eventList)) {
			continue;
		}

		for (const event of eventList) {
			const shipmentEvent = event as AmazonShipmentLikeEvent;
			if (
				!shipmentEvent?.AmazonOrderId ||
				shipmentEvent.AmazonOrderId === orderId
			) {
				matchedEvents.push({
					listName,
					event: shipmentEvent,
				});
			}
		}
	}

	return matchedEvents;
}

export function classifyFinancialEvents(args: {
	financialEvents: AmazonFinancialEvents | null | undefined;
	orderTimestamp: number;
	shipmentLikeEventCount: number;
}) {
	const eventListCounts = getEventListCounts(args.financialEvents);
	const nonEmptyEventLists = eventListCounts.filter(
		(eventList) => eventList.count > 0,
	);
	const hasAnyFinancialEvents = nonEmptyEventLists.length > 0;
	const shipmentLikeListNames = new Set<string>(AMAZON_SHIPMENT_EVENT_LISTS);
	const hasNonShipmentFinancialEvents = nonEmptyEventLists.some(
		(eventList) => !shipmentLikeListNames.has(eventList.listName),
	);
	const orderAgeDays =
		(Date.now() - args.orderTimestamp) / (24 * 60 * 60 * 1000);
	const suggestFinancesV2024Fallback =
		orderAgeDays >= AMAZON_FINANCE_V2024_REVIEW_AGE_DAYS &&
		(!hasAnyFinancialEvents || args.shipmentLikeEventCount === 0);

	let financeStatusClassification = "other_finance_present";
	if (!hasAnyFinancialEvents) {
		financeStatusClassification = "empty_v0_response";
	} else if (args.shipmentLikeEventCount > 0) {
		financeStatusClassification = "shipment_finance_present";
	} else if (hasNonShipmentFinancialEvents) {
		financeStatusClassification = "non_shipment_finance_present";
	}

	return {
		hasAnyFinancialEvents,
		hasNonShipmentFinancialEvents,
		financeStatusClassification,
		suggestFinancesV2024Fallback,
		nonEmptyEventLists: nonEmptyEventLists.map(
			({ listName, count }): [string, number] => [listName, count],
		),
	};
}

export function extractFulfillmentFromShipmentLikeEvents(
	shipmentLikeEvents: AmazonShipmentLikeEventMatch[],
) {
	let fulfillmentTimestamp: number | undefined;
	let fulfillmentDate: string | undefined;
	let fulfillmentSourceList: string | undefined;

	for (const shipmentLikeEvent of shipmentLikeEvents) {
		const postedDate = shipmentLikeEvent.event.PostedDate;
		const shipmentDate = shipmentLikeEvent.event.ShipmentDate;
		const dateToUse = postedDate || shipmentDate;

		if (!dateToUse) {
			continue;
		}

		const parsedDate = new Date(dateToUse).getTime();
		if (!fulfillmentTimestamp || parsedDate < fulfillmentTimestamp) {
			fulfillmentTimestamp = parsedDate;
			fulfillmentDate = dateToUse;
			fulfillmentSourceList = shipmentLikeEvent.listName;
		}
	}

	return {
		fulfillmentTimestamp,
		fulfillmentDate,
		fulfillmentSourceList,
	};
}

export function extractFulfillmentFromAdjustmentEvents(args: {
	adjustmentEvents: AmazonAdjustmentEvent[] | undefined;
	orderTimestamp: number;
}) {
	let fulfillmentTimestamp: number | undefined;
	let fulfillmentDate: string | undefined;
	let fulfillmentSourceList: string | undefined;
	const now = Date.now();

	for (const adjustment of args.adjustmentEvents || []) {
		const adjustmentType = adjustment?.AdjustmentType || "";
		if (adjustmentType !== "PostageBilling_Postage") {
			continue;
		}

		const adjustmentAmount = parseApiFloat(
			adjustment.AdjustmentAmount?.CurrencyAmount,
		);
		if (!Number.isFinite(adjustmentAmount) || adjustmentAmount >= 0) {
			continue;
		}

		const postedDate = adjustment.PostedDate;
		if (!postedDate) {
			continue;
		}

		const parsedDate = new Date(postedDate).getTime();
		if (!Number.isFinite(parsedDate)) {
			continue;
		}

		if (parsedDate < args.orderTimestamp || parsedDate > now) {
			continue;
		}

		if (!fulfillmentTimestamp || parsedDate < fulfillmentTimestamp) {
			fulfillmentTimestamp = parsedDate;
			fulfillmentDate = postedDate;
			fulfillmentSourceList = `AdjustmentEventList:${adjustmentType}`;
		}
	}

	return {
		fulfillmentTimestamp,
		fulfillmentDate,
		fulfillmentSourceList,
	};
}

export async function fetchFulfillmentFromOrderPackages(args: {
	spApi: SpApiGet;
	orderId: string;
	orderTimestamp: number;
}) {
	const createdAfter = new Date(
		args.orderTimestamp - 24 * 60 * 60 * 1000,
	).toISOString();
	const createdBefore = new Date(
		Math.max(args.orderTimestamp + 30 * 24 * 60 * 60 * 1000, Date.now()),
	).toISOString();

	const ordersResponse = asRecord(
		await args.spApi(
			withQuery("/orders/v0/orders", {
				MarketplaceIds: MARKETPLACE_US,
				CreatedAfter: createdAfter,
				CreatedBefore: createdBefore,
				OrderStatuses: "Shipped,PartiallyShipped",
				AmazonOrderIds: args.orderId,
				includedData: "PACKAGES",
			}),
		),
	);

	const matchingOrder = (
		(ordersResponse?.Orders || []) as Array<Record<string, unknown>>
	).find((order) => order?.AmazonOrderId === args.orderId);
	const packages = matchingOrder?.packages || matchingOrder?.Packages || [];
	let fulfillmentTimestamp: number | undefined;
	let fulfillmentDate: string | undefined;

	for (const orderPackage of packages as unknown[]) {
		const pkg = asRecord(orderPackage);
		const shipTime = asString(pkg?.shipTime) ?? asString(pkg?.ShipTime);
		if (!shipTime) {
			continue;
		}

		const parsedShipTime = new Date(shipTime).getTime();
		if (!Number.isFinite(parsedShipTime)) {
			continue;
		}

		if (!fulfillmentTimestamp || parsedShipTime < fulfillmentTimestamp) {
			fulfillmentTimestamp = parsedShipTime;
			fulfillmentDate = shipTime;
		}
	}

	return {
		fulfillmentTimestamp,
		fulfillmentDate,
		fulfillmentSourceList: fulfillmentTimestamp
			? "getOrders.packages[].shipTime"
			: undefined,
	};
}

export function extractFBAFeesFromShipmentLikeEvents(
	shipmentLikeEvents: AmazonShipmentLikeEventMatch[],
) {
	let totalFBAFees = 0;
	const fbaFeesBySKU: Record<string, number> = {};

	for (const shipmentLikeEvent of shipmentLikeEvents) {
		const shipmentEvent = shipmentLikeEvent.event;
		if (shipmentEvent.ShipmentItemList) {
			for (const shipmentItem of shipmentEvent.ShipmentItemList) {
				const sku = shipmentItem.SellerSKU || "";
				let itemFBAFees = 0;

				if (shipmentItem.ItemFeeList) {
					for (const fee of shipmentItem.ItemFeeList) {
						const feeType = (fee.FeeType || fee.FeeName || "").toUpperCase();
						if (
							feeType.includes("FBA") ||
							feeType.includes("FULFILLMENT") ||
							feeType.includes("WEIGHT") ||
							feeType.includes("PICK") ||
							feeType.includes("PACK")
						) {
							const feeAmount = Math.abs(
								parseApiFloat(fee.FeeAmount?.CurrencyAmount),
							);
							itemFBAFees += feeAmount;
						}
					}
				}

				if (itemFBAFees > 0) {
					fbaFeesBySKU[sku] = (fbaFeesBySKU[sku] || 0) + itemFBAFees;
					totalFBAFees += itemFBAFees;
				}
			}
		}

		if (shipmentEvent.OrderFeeList) {
			for (const fee of shipmentEvent.OrderFeeList) {
				const feeType = (fee.FeeType || fee.FeeName || "").toUpperCase();
				if (feeType.includes("FBA") || feeType.includes("FULFILLMENT")) {
					const feeAmount = Math.abs(
						parseApiFloat(fee.FeeAmount?.CurrencyAmount),
					);
					totalFBAFees += feeAmount;
				}
			}
		}
	}

	return {
		totalFBAFees,
		fbaFeesBySKU,
	};
}

export function extractItemFeesFromShipmentLikeEvents(args: {
	shipmentLikeEvents: AmazonShipmentLikeEventMatch[];
	sellerSKU: string;
	isFBA: boolean;
}) {
	let actualFees = 0;
	const feesBreakdown: Array<[string, number]> = [];
	const feeSourceLists = new Set<string>();

	for (const shipmentLikeEvent of args.shipmentLikeEvents) {
		const shipmentEvent = shipmentLikeEvent.event;

		if (shipmentEvent.ShipmentItemList) {
			for (const shipmentItem of shipmentEvent.ShipmentItemList) {
				if (shipmentItem.SellerSKU !== args.sellerSKU) {
					continue;
				}

				if (shipmentItem.ItemFeeList) {
					for (const fee of shipmentItem.ItemFeeList) {
						const feeType = fee.FeeType || fee.FeeName || "Item Fee";
						const feeTypeUpper = feeType.toUpperCase();

						if (
							args.isFBA &&
							(feeTypeUpper.includes("FBA") ||
								feeTypeUpper.includes("FULFILLMENT") ||
								feeTypeUpper.includes("WEIGHT") ||
								feeTypeUpper.includes("PICK") ||
								feeTypeUpper.includes("PACK"))
						) {
							continue;
						}

						const feeAmount = Math.abs(
							parseApiFloat(fee.FeeAmount?.CurrencyAmount),
						);
						actualFees += feeAmount;
						feesBreakdown.push([feeType, feeAmount]);
						feeSourceLists.add(shipmentLikeEvent.listName);
					}
				}
			}
		}

		if (shipmentEvent.OrderFeeList) {
			for (const fee of shipmentEvent.OrderFeeList) {
				const feeType = fee.FeeType || fee.FeeName || "Order Fee";
				const feeTypeUpper = feeType.toUpperCase();

				if (
					args.isFBA &&
					(feeTypeUpper.includes("FBA") || feeTypeUpper.includes("FULFILLMENT"))
				) {
					continue;
				}

				const feeAmount = Math.abs(
					parseApiFloat(fee.FeeAmount?.CurrencyAmount),
				);
				actualFees += feeAmount;
				feesBreakdown.push([feeType, feeAmount]);
				feeSourceLists.add(shipmentLikeEvent.listName);
			}
		}
	}

	return {
		actualFees,
		feesBreakdown,
		feeSourceLists: Array.from(feeSourceLists),
	};
}
