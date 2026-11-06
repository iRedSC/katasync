import { type } from "arktype";
import { shopifyQuery } from "#/channels/shopify/client";
import type { ShopifySalesRow, Statement } from "./types";
import type { MonthWindow } from "./window";

// Shopify's sales report for the month, by sales channel: the same figures as
// Analytics' "Total sales" (ShopifyQL's sales dataset), in the shop's own time
// zone. Shopify books each change on the day it happens: an order edited or
// refunded later counts on that later day, not the order's.

const COLUMNS = [
	"orders",
	"gross_sales",
	"discounts",
	"returns",
	"net_sales",
	"shipping_charges",
	"duties",
	"additional_fees",
	"taxes",
	"total_sales",
] as const;

export function salesQuery(month: MonthWindow) {
	return [
		"FROM sales",
		`SHOW ${COLUMNS.join(", ")}`,
		"GROUP BY sales_channel",
		`SINCE ${month.firstDay} UNTIL ${month.lastDay}`,
	].join(" ");
}

const SHOPIFYQL = `query($q: String!) {
	shopifyqlQuery(query: $q) { tableData { rows } parseErrors }
}`;

const amount = "string.numeric.parse | number";
const row = type({
	"sales_channel?": "string | null",
	orders: amount,
	gross_sales: amount,
	discounts: amount,
	returns: amount,
	net_sales: amount,
	shipping_charges: amount,
	duties: amount,
	additional_fees: amount,
	taxes: amount,
	total_sales: amount,
});
const answer = type({
	shopifyqlQuery: {
		"tableData?": type({ rows: row.array() }).or("null"),
		"parseErrors?": "string[] | null",
	},
});

export function shopifyRows(rows: (typeof row.infer)[]): ShopifySalesRow[] {
	return rows.map((r) => ({
		salesChannel: r.sales_channel || "Other",
		orders: r.orders,
		grossSales: r.gross_sales,
		discounts: r.discounts,
		returns: r.returns,
		netSales: r.net_sales,
		shipping: r.shipping_charges,
		duties: r.duties,
		additionalFees: r.additional_fees,
		taxes: r.taxes,
		totalSales: r.total_sales,
	}));
}

export async function shopifyStatement(month: MonthWindow): Promise<Statement> {
	const { shopifyqlQuery } = answer.assert(
		await shopifyQuery(SHOPIFYQL, { q: salesQuery(month) }),
	);
	if (shopifyqlQuery.parseErrors?.length)
		throw new Error(`ShopifyQL: ${shopifyqlQuery.parseErrors.join("; ")}`);
	if (!shopifyqlQuery.tableData)
		throw new Error("Shopify sent no sales report");
	return {
		channel: "shopify",
		window: month.json,
		rows: shopifyRows(shopifyqlQuery.tableData.rows).sort(
			(a, b) => b.totalSales - a.totalSales,
		),
	};
}
