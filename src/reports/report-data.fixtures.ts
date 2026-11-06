import type { ReportData } from "./snapshot";

type Current = Extract<ReportData, { schemaVersion: 2 }>;

const fees = (orders: number, amount: number) => ({ orders, amount });

export function reportDataFixture(over: Partial<Current> = {}): Current {
	return {
		schemaVersion: 2,
		kind: "sales_tax_month",
		period: "2026-09",
		basis: "marketplace_statements",
		statements: [
			{
				channel: "ebay",
				state: "read",
				statement: {
					channel: "ebay",
					window: {
						start: "2026-09-01T07:00:00.000Z",
						end: "2026-10-01T07:00:00.000Z",
						timeZone: "America/Los_Angeles",
					},
					netSales: 100,
					marketplaceTax: 7,
					sections: [
						{
							title: null,
							lines: [
								{ label: "Gross sales", amount: 100 },
								{ label: "Selling fees", amount: -13 },
							],
							total: { label: "Orders (total minus fees)", amount: 87 },
						},
					],
				},
			},
			{ channel: "shopify", state: "missing", error: null },
			{ channel: "amazon", state: "missing", error: "Amazon answered 403" },
			{ channel: "tiktok", state: "missing", error: null },
		],
		currency: "USD",
		timeZone: "America/New_York",
		source: "test",
		window: {
			start: "2026-09-01T04:00:00.000Z",
			end: "2026-10-01T04:00:00.000Z",
		},
		business: { name: "East Coast Drywall Tools", homeState: "PA" },
		channels: [
			{
				source: "shopify",
				orders: 2,
				itemSales: 100,
				shipping: 10,
				grossSales: 110,
				marketplaceTax: 0,
				ourTax: 6.6,
				refunds: 0,
				fees: 3.5,
				labels: 8,
				postageAdjustments: 0,
				adjustments: 0,
				proceedsBeforeCost: 98.5,
				feesEstimated: 0,
				taxUnknown: 0,
			},
		],
		jurisdictions: [
			{
				country: "US",
				jurisdiction: "Pennsylvania State Tax",
				rate: 0.06,
				orders: 2,
				taxedSales: 110,
				tax: 6.6,
			},
		],
		states: [
			{
				country: "US",
				state: "PA",
				how: "shipped",
				orders: 2,
				taxedOrders: 2,
				sales: 110,
				tax: 6.6,
			},
		],
		deposits: [
			{
				externalId: "payout-1",
				channel: "shopify",
				status: "sent",
				depositedAt: "2026-09-10T14:00:00.000Z",
				amount: 90,
				currency: "USD",
				bankTail: "1234",
				reference: "=cmd|' /C calc'!A0",
			},
		],
		payoutErrors: [],
		partial: [],
		contribution: {
			orders: 2,
			revenue: 100,
			shippingCharged: 10,
			cost: 40,
			costUnknown: 0,
			costCorrections: 1.25,
			fees: 3.5,
			estimatedFees: 0,
			feesEstimated: 0,
			labels: 8,
			labelsMissing: 0,
			labelsStandIn: 0,
			labelsAwaiting: 0,
			postageAdjustments: 0,
			refunds: 0,
			adjustments: 0,
			awaitingReturn: 0,
			contribution: 57.25,
		},
		evidence: [
			{
				soldOn: "shopify",
				orders: 2,
				fees: {
					settled: fees(0, 0),
					reported: fees(1, 1.5),
					aged_out: fees(1, 2),
					estimated: fees(0, 0),
				},
				labelsMissing: 0,
				labelsStandIn: 0,
				labelsAwaiting: 0,
				costUnknown: 0,
				taxUnknown: 0,
			},
		],
		...over,
	};
}
