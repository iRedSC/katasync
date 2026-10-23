import { formatCents } from "#/banking/money";
import { Badge, Card } from "#/components/page";
import { formatCount, formatDate, formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";
import {
	BANK_STATE,
	MARKET_STATUS,
	type Overview,
	ROW_STATE,
	type Row,
	type RowFilter,
	rowsFor,
} from "./states";

const th = "px-4 py-2 font-medium";
const td = "px-4 py-2.5";

export function BankRows({
	rows,
	currency,
	truncated,
	filter,
	onFilter,
	onOpen,
}: {
	rows: Row[];
	currency: string;
	truncated: boolean;
	filter: RowFilter;
	onFilter: (f: RowFilter) => void;
	onOpen: (row: Row) => void;
}) {
	const tabs: [RowFilter, string][] = [
		["needs-review", "Needs review"],
		["unmatched", "Unmatched"],
		["matched", "Matched"],
		["all", "All"],
	];
	const shown = rowsFor(rows, filter);
	const open = rowsFor(rows, "unmatched").reduce(
		(s, r) => s + r.amountCents,
		0,
	);
	return (
		<Card
			flush
			title={
				<span className="flex flex-wrap items-center gap-1">
					{tabs.map(([k, label]) => {
						const n = rowsFor(rows, k).length;
						if (k === "needs-review" && n === 0) return null;
						return (
							<button
								key={k}
								type="button"
								onClick={() => onFilter(k)}
								className={cn(
									"h-7 rounded-md px-2.5 text-xs font-normal hover:bg-surface-strong",
									filter === k && "bg-subtle font-medium",
									k === "needs-review" && "text-warning-text",
								)}
							>
								{label} <span className="tabular-nums">{formatCount(n)}</span>
							</button>
						);
					})}
				</span>
			}
			aside={
				open !== 0 && (
					<span className="tabular-nums">
						{formatCents(open, currency)} unmatched
					</span>
				)
			}
		>
			{shown.length === 0 ? (
				<p className="px-4 pb-4 text-muted-foreground">Nothing here.</p>
			) : (
				<table className="w-full">
					<thead>
						<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
							<th className={th}>Date</th>
							<th className={th}>Description</th>
							<th className={cn(th, "text-right")}>Amount</th>
							<th className={th}>State</th>
						</tr>
					</thead>
					<tbody>
						{shown.map((r) => (
							<tr
								key={r.id}
								onClick={() => onOpen(r)}
								className={cn(
									"cursor-pointer border-t hover:bg-subtle",
									r.state.kind === "needs-review" && "bg-warning-surface/40",
								)}
							>
								<td
									className={cn(td, "whitespace-nowrap text-muted-foreground")}
								>
									{formatDate(r.postedOn)}
								</td>
								<td className={cn(td, "max-w-lg truncate")}>
									{r.description}
									{r.possibleRepeat && (
										<span className="ml-2">
											<Badge tone="warning">In another import too</Badge>
										</span>
									)}
								</td>
								<td
									className={cn(
										td,
										"text-right tabular-nums",
										r.amountCents > 0 && "text-success-text",
									)}
								>
									{formatCents(r.amountCents, currency)}
								</td>
								<td className={td}>
									<span className="flex items-center gap-2">
										<Badge tone={ROW_STATE[r.state.kind].tone}>
											{ROW_STATE[r.state.kind].label}
										</Badge>
										{r.state.kind !== "unmatched" && (
											<span className="truncate text-xs text-muted-foreground">
												{r.state.match.parts.map((p) => p.label).join(" + ")}
											</span>
										)}
									</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{truncated && (
				<p className="border-t px-4 py-2 text-xs text-muted-foreground">
					Showing the newest 1,000 rows
				</p>
			)}
		</Card>
	);
}

export function PayoutsCard({
	payouts,
	currency,
}: {
	payouts: Overview["payouts"];
	currency: string;
}) {
	if (payouts.length === 0) return null;
	return (
		<Card flush title={`Marketplace payouts in ${currency}`}>
			<table className="w-full">
				<thead>
					<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
						<th className={th}>Date</th>
						<th className={th}>Payout</th>
						<th className={cn(th, "text-right")}>Amount</th>
						<th className={th}>Marketplace</th>
						<th className={th}>Bank</th>
					</tr>
				</thead>
				<tbody>
					{payouts.map((p) => (
						<tr key={`${p.ref.kind}:${p.ref.id}`} className="border-t">
							<td className={cn(td, "whitespace-nowrap text-muted-foreground")}>
								{formatDate(p.on)}
							</td>
							<td className={cn(td, "max-w-sm truncate")}>{p.label}</td>
							<td className={cn(td, "text-right tabular-nums")}>
								{formatCents(p.amountCents, p.currency)}
								{p.bank === "partial" && (
									<span className="block text-xs text-muted-foreground">
										{formatCents(p.allocatedCents, p.currency)} in bank
									</span>
								)}
							</td>
							<td className={td}>
								<Badge tone={MARKET_STATUS[p.status]?.tone}>
									{MARKET_STATUS[p.status]?.label ?? p.status}
								</Badge>
							</td>
							<td className={td}>
								<Badge tone={BANK_STATE[p.bank].tone}>
									{BANK_STATE[p.bank].label}
								</Badge>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</Card>
	);
}

export function ImportsCard({ imports }: { imports: Overview["imports"] }) {
	if (imports.length === 0) return null;
	return (
		<Card flush title="Imports">
			<ul className="divide-y border-t">
				{imports.map((i) => (
					<li
						key={i.id}
						className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
					>
						<span className="font-medium">#{i.id}</span>
						<span className="truncate">{i.fileName ?? "Pasted"}</span>
						<span className="text-xs text-muted-foreground">
							{formatDateTime(i.importedAt)}
						</span>
						<span className="ml-auto flex gap-1.5">
							<Badge tone="success">
								{formatCount(i.counts.accepted)} added
							</Badge>
							{i.counts.duplicate > 0 && (
								<Badge>{formatCount(i.counts.duplicate)} already in</Badge>
							)}
							{i.counts.skipped > 0 && (
								<Badge>{formatCount(i.counts.skipped)} left out</Badge>
							)}
							{i.counts.invalid > 0 && (
								<Badge tone="critical">
									{formatCount(i.counts.invalid)} unreadable
								</Badge>
							)}
						</span>
					</li>
				))}
			</ul>
		</Card>
	);
}
