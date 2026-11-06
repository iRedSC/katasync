import { type } from "arktype";
import { shopCipher, tiktokApi } from "#/channels/tiktok";
import { cents, type Statement, type StatementLine } from "./types";
import type { MonthWindow } from "./window";

// TikTok's statements dated in the month (Pacific time), as Seller Center's
// Finance > Statements lists them. Each settles the orders delivered a week
// or more before, so this is money settled, not the month's sales.

const amount = "string.numeric.parse";
export const tiktokStatementRow = type({
	id: "string",
	statement_time: "number",
	revenue_amount: amount,
	fee_amount: amount,
	"shipping_cost_amount?": amount,
	"adjustment_amount?": amount,
	settlement_amount: amount,
});
type Row = typeof tiktokStatementRow.infer;
const page = type({
	"statements?": tiktokStatementRow.array(),
	"next_page_token?": "string",
});

export function tiktokStatement(month: MonthWindow, rows: Row[]): Statement {
	const sum = (get: (r: Row) => number) =>
		cents(rows.reduce((s, r) => s + get(r), 0));
	const lines: StatementLine[] = [
		{ label: "Revenue", amount: sum((r) => r.revenue_amount) },
		{ label: "Fees", amount: sum((r) => r.fee_amount) },
		{ label: "Shipping", amount: sum((r) => r.shipping_cost_amount ?? 0) },
		{ label: "Adjustments", amount: sum((r) => r.adjustment_amount ?? 0) },
	];
	const settled = sum((r) => r.settlement_amount);
	// Whatever TikTok settled beyond the parts it names, so the lines always
	// add up to its own total.
	const rest = cents(settled - lines.reduce((s, l) => s + l.amount, 0));
	if (rest !== 0) lines.push({ label: "Other", amount: rest });
	return {
		channel: "tiktok",
		window: month.json,
		statements: rows.length,
		sections: [
			{
				title: null,
				lines,
				total: { label: "Total settlement", amount: settled },
			},
		],
	};
}

export async function fetchTiktokStatement(month: MonthWindow) {
	const cipher = await shopCipher();
	const rows = new Map<string, Row>();
	let token: string | undefined;
	do {
		const data = page.assert(
			await tiktokApi("/finance/202309/statements", {
				shop_cipher: cipher,
				statement_time_ge: String(Math.floor(month.start.getTime() / 1000)),
				statement_time_lt: String(Math.floor(month.end.getTime() / 1000)),
				sort_field: "statement_time",
				page_size: "100",
				...(token ? { page_token: token } : {}),
			}),
		);
		for (const r of data.statements ?? []) rows.set(r.id, r);
		token = data.next_page_token || undefined;
	} while (token);
	return tiktokStatement(month, [...rows.values()]);
}
