import { toCsv } from "#/banking/export";
import type { Tone } from "#/components/page";
import type { Reconciliation } from "#/server/banking";

export type Overview = Reconciliation;
export type Row = Overview["rows"][number];
export type PayoutRow = Overview["payouts"][number];
export type RowFilter = "needs-review" | "unmatched" | "matched" | "all";

export const ROW_STATE: Record<
	Row["state"]["kind"],
	{ label: string; tone?: Tone }
> = {
	unmatched: { label: "Unmatched" },
	matched: { label: "Matched", tone: "success" },
	"needs-review": { label: "Needs review", tone: "warning" },
};

export const MARKET_STATUS: Record<string, { label: string; tone?: Tone }> = {
	sent: { label: "Sent" },
	pending: { label: "Pending", tone: "info" },
	failed: { label: "Failed", tone: "critical" },
};

export const BANK_STATE: Record<
	PayoutRow["bank"],
	{ label: string; tone?: Tone }
> = {
	none: { label: "Not in bank" },
	partial: { label: "Partly in bank", tone: "info" },
	matched: { label: "In bank", tone: "success" },
	"needs-review": { label: "Needs review", tone: "warning" },
};

export function rowsFor(rows: readonly Row[], filter: RowFilter) {
	return filter === "all" ? rows : rows.filter((r) => r.state.kind === filter);
}

export function downloadRows(
	name: string,
	currency: string,
	rows: readonly Row[],
) {
	const lines = [
		[
			"Date",
			"Description",
			"Amount",
			"Currency",
			"Bank ID",
			"State",
			"Matched to",
		],
		...rows.map((r) => [
			r.postedOn,
			r.description,
			r.amountCents / 100,
			currency,
			r.bankRef,
			ROW_STATE[r.state.kind].label,
			r.state.kind === "unmatched"
				? null
				: r.state.match.parts.map((p) => p.label).join("; "),
		]),
	];
	const url = URL.createObjectURL(
		new Blob([toCsv(lines)], { type: "text/csv" }),
	);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${name.replace(/[^\w-]+/g, "-")}-reconciliation.csv`;
	a.click();
	URL.revokeObjectURL(url);
}
