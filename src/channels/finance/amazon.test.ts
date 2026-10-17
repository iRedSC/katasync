import { afterEach, describe, expect, test, vi } from "vitest";
import {
	classifyFinancialEvents,
	extractFBAFeesFromShipmentLikeEvents,
	extractFulfillmentFromAdjustmentEvents,
	extractFulfillmentFromShipmentLikeEvents,
	extractItemFeesFromShipmentLikeEvents,
	fetchFinancialEventsForOrder,
	fetchFulfillmentFromOrderPackages,
	fetchTransactionsForOrder,
	getShipmentLikeEvents,
	mergeFinancialEvents,
	transactionsToShipmentEvents,
} from "./amazon";

afterEach(() => vi.useRealTimers());

describe("Amazon finance contracts", () => {
	test("merges paginated event arrays without replacing first-page metadata", () => {
		const target: Record<string, unknown> = {
			ShipmentEventList: [{ id: 1 }],
			Currency: "USD",
		};
		mergeFinancialEvents(target, {
			ShipmentEventList: [{ id: 2 }],
			Currency: "CAD",
			AdjustmentEventList: [{ id: 3 }],
		});

		expect(target).toEqual({
			ShipmentEventList: [{ id: 1 }, { id: 2 }],
			Currency: "USD",
			AdjustmentEventList: [{ id: 3 }],
		});
	});

	test("collects classic, settlement, and trial shipment events for the order", () => {
		const events = getShipmentLikeEvents(
			{
				ShipmentEventList: [
					{ AmazonOrderId: "wanted" },
					{ AmazonOrderId: "other" },
					{ noOrderId: true },
				],
				ShipmentSettleEventList: [{ AmazonOrderId: "wanted" }],
				TrialShipmentEventList: [{ AmazonOrderId: "wanted" }],
			},
			"wanted",
		);

		expect(events.map(({ listName }) => listName)).toEqual([
			"ShipmentEventList",
			"ShipmentEventList",
			"ShipmentSettleEventList",
			"TrialShipmentEventList",
		]);
	});

	test("flags old orders with no shipment finance for fallback review", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-17T00:00:00.000Z"));
		expect(
			classifyFinancialEvents({
				financialEvents: { AdjustmentEventList: [{ id: 1 }] },
				orderTimestamp: Date.parse("2026-08-01T00:00:00.000Z"),
				shipmentLikeEventCount: 0,
			}),
		).toMatchObject({
			hasAnyFinancialEvents: true,
			hasNonShipmentFinancialEvents: true,
			financeStatusClassification: "non_shipment_finance_present",
			suggestFinancesV2024Fallback: true,
			nonEmptyEventLists: [["AdjustmentEventList", 1]],
		});
	});

	test("uses the earliest valid fulfillment evidence", () => {
		expect(
			extractFulfillmentFromShipmentLikeEvents([
				{
					listName: "ShipmentEventList",
					event: { PostedDate: "2026-08-12T00:00:00.000Z" },
				},
				{
					listName: "ShipmentSettleEventList",
					event: { ShipmentDate: "2026-08-10T00:00:00.000Z" },
				},
			]),
		).toEqual({
			fulfillmentTimestamp: Date.parse("2026-08-10T00:00:00.000Z"),
			fulfillmentDate: "2026-08-10T00:00:00.000Z",
			fulfillmentSourceList: "ShipmentSettleEventList",
		});
	});

	test("accepts only negative postage adjustments within the order window", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-17T00:00:00.000Z"));
		expect(
			extractFulfillmentFromAdjustmentEvents({
				orderTimestamp: Date.parse("2026-08-01T00:00:00.000Z"),
				adjustmentEvents: [
					{
						AdjustmentType: "PostageBilling_Postage",
						AdjustmentAmount: { CurrencyAmount: "-5.25" },
						PostedDate: "2026-08-10T00:00:00.000Z",
					},
					{
						AdjustmentType: "PostageBilling_Postage",
						AdjustmentAmount: { CurrencyAmount: "5.25" },
						PostedDate: "2026-08-09T00:00:00.000Z",
					},
				],
			}),
		).toEqual({
			fulfillmentTimestamp: Date.parse("2026-08-10T00:00:00.000Z"),
			fulfillmentDate: "2026-08-10T00:00:00.000Z",
			fulfillmentSourceList: "AdjustmentEventList:PostageBilling_Postage",
		});
	});

	test("separates FBA fulfillment fees from other item and order fees", () => {
		const shipmentEvents = [
			{
				listName: "ShipmentEventList",
				event: {
					ShipmentItemList: [
						{
							SellerSKU: "SKU-1",
							ItemFeeList: [
								{
									FeeType: "FBAFulfillmentFee",
									FeeAmount: { CurrencyAmount: "-4.50" },
								},
								{
									FeeType: "Commission",
									FeeAmount: { CurrencyAmount: "-3.25" },
								},
							],
						},
					],
					OrderFeeList: [
						{
							FeeType: "OrderFee",
							FeeAmount: { CurrencyAmount: "-1.25" },
						},
					],
				},
			},
		];

		expect(extractFBAFeesFromShipmentLikeEvents(shipmentEvents)).toEqual({
			totalFBAFees: 4.5,
			fbaFeesBySKU: { "SKU-1": 4.5 },
		});
		expect(
			extractItemFeesFromShipmentLikeEvents({
				shipmentLikeEvents: shipmentEvents,
				sellerSKU: "SKU-1",
				isFBA: true,
			}),
		).toEqual({
			actualFees: 4.5,
			feesBreakdown: [
				["Commission", 3.25],
				["OrderFee", 1.25],
			],
			feeSourceLists: ["ShipmentEventList"],
		});
	});

	test("reads deferred FBA shipment fees from Finances 2024-06-19 transactions", () => {
		const amount = (currencyAmount: number) => ({ currencyAmount });
		const shipment = (
			status: string,
			postedDate: string,
			extraIds: string[],
		) => ({
			transactionType: "Shipment",
			transactionStatus: status,
			postedDate,
			relatedIdentifiers: [
				{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "113-1" },
				...extraIds.map((name) => ({
					relatedIdentifierName: name,
					relatedIdentifierValue: "x",
				})),
			],
			items: [
				{
					contexts: [{ sku: "SKU-FBA", quantityShipped: 1 }],
					breakdowns: [
						{ breakdownType: "ProductCharges", breakdownAmount: amount(19.75) },
						{
							breakdownType: "AmazonFees",
							breakdownAmount: amount(-6.82),
							breakdowns: [
								{
									breakdownType: "FBAPerUnitFulfillmentFee",
									breakdownAmount: amount(-3.86),
								},
								{ breakdownType: "Commission", breakdownAmount: amount(-2.96) },
							],
						},
					],
				},
			],
		});

		// A released deferral appears twice; only the original shipment posting counts.
		const events = transactionsToShipmentEvents(
			[
				shipment("DEFERRED_RELEASED", "2026-08-26T01:04:44Z", [
					"RELEASE_TRANSACTION_ID",
				]),
				shipment("RELEASED", "2026-09-06T23:51:41Z", [
					"DEFERRED_TRANSACTION_ID",
				]),
				{ transactionType: "Refund", postedDate: "2026-09-10T00:00:00Z" },
			],
			"113-1",
		);
		expect(events).toHaveLength(1);
		expect(events[0].PostedDate).toBe("2026-08-26T01:04:44Z");

		const shipmentLikeEvents = getShipmentLikeEvents(
			{ ShipmentEventList: events },
			"113-1",
		);
		expect(extractFBAFeesFromShipmentLikeEvents(shipmentLikeEvents)).toEqual({
			totalFBAFees: 3.86,
			fbaFeesBySKU: { "SKU-FBA": 3.86 },
		});
		expect(
			extractItemFeesFromShipmentLikeEvents({
				shipmentLikeEvents,
				sellerSKU: "SKU-FBA",
				isFBA: true,
			}).feesBreakdown,
		).toEqual([["Commission", 2.96]]);
	});

	test("follows NextToken across financial event pages and merges them", async () => {
		const paths: string[] = [];
		const pages = [
			{
				NextToken: "page-2",
				FinancialEvents: { ShipmentEventList: [{ id: 1 }] },
			},
			{ FinancialEvents: { ShipmentEventList: [{ id: 2 }] } },
		];
		const spApi = async (path: string) => {
			paths.push(path);
			return pages[paths.length - 1];
		};

		const result = await fetchFinancialEventsForOrder(spApi, "113-1");

		expect(paths).toEqual([
			"/finances/v0/financialEventsByOrderId/113-1?MaxResultsPerPage=100",
			"/finances/v0/financialEventsByOrderId/113-1?MaxResultsPerPage=100&NextToken=page-2",
		]);
		expect(result).toEqual({
			financialEvents: { ShipmentEventList: [{ id: 1 }, { id: 2 }] },
			pagesFetched: 2,
		});
	});

	test("follows nextToken across 2024-06-19 transaction pages", async () => {
		const paths: string[] = [];
		const pages = [
			{ transactions: [{ transactionType: "Shipment" }], nextToken: "t-2" },
			{ transactions: [{ transactionType: "Refund" }] },
		];
		const spApi = async (path: string) => {
			paths.push(path);
			return pages[paths.length - 1];
		};

		const transactions = await fetchTransactionsForOrder(spApi, "113-1");

		expect(paths[1]).toBe(
			"/finances/2024-06-19/transactions?relatedIdentifierName=ORDER_ID&relatedIdentifierValue=113-1&nextToken=t-2",
		);
		expect(transactions).toEqual([
			{ transactionType: "Shipment" },
			{ transactionType: "Refund" },
		]);
	});

	test("takes the earliest shipTime of the matching order's packages", async () => {
		const spApi = async () => ({
			Orders: [
				{
					AmazonOrderId: "other",
					packages: [{ shipTime: "2026-08-01T00:00:00Z" }],
				},
				{
					AmazonOrderId: "113-1",
					Packages: [
						{ ShipTime: "2026-08-12T00:00:00Z" },
						{ shipTime: "2026-08-10T00:00:00Z" },
					],
				},
			],
		});

		const result = await fetchFulfillmentFromOrderPackages({
			spApi,
			orderId: "113-1",
			orderTimestamp: Date.parse("2026-08-09T00:00:00Z"),
		});

		expect(result).toEqual({
			fulfillmentTimestamp: Date.parse("2026-08-10T00:00:00Z"),
			fulfillmentDate: "2026-08-10T00:00:00Z",
			fulfillmentSourceList: "getOrders.packages[].shipTime",
		});
	});
});
