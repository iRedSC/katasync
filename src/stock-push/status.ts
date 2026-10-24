import { STOCK_WRITE_HOLD } from "./policy";

export type StockPushRow = { on: boolean };
export type StockPushStatus =
	| { kind: "off" }
	| { kind: "blocked"; why: string };

export function stockPushStatus(
	row: StockPushRow,
	context: { writes: boolean; blocker: string | null },
): StockPushStatus {
	return row.on
		? { kind: "blocked", why: context.blocker ?? STOCK_WRITE_HOLD }
		: { kind: "off" };
}
