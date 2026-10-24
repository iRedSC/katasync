import { Loader2 } from "lucide-react";
import { useState } from "react";
import { formatCents } from "#/banking/money";
import { Badge } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Previewed } from "./import-step";

type Row = Previewed["rows"][number];
type Filter = "all" | "repeats" | "duplicate" | "invalid";

const SHOWN = 300;

const isRepeat = (r: Row) => r.kind === "accepted" && r.repeatOf !== null;

export function ImportPreview({
	currency,
	preview,
	skip,
	problem,
	busy,
	retry,
	onSkip,
	onBack,
	onImport,
	onCorrect,
}: {
	currency: string;
	preview: Previewed;
	skip: ReadonlySet<number>;
	problem: string | null;
	busy: boolean;
	retry: boolean;
	onSkip: (skip: ReadonlySet<number>) => void;
	onBack: () => void;
	onImport: (keep: ReadonlySet<number>) => void;
	onCorrect: () => void;
}) {
	const [keep, setKeep] = useState<ReadonlySet<number>>(new Set());
	const [filter, setFilter] = useState<Filter>(() =>
		preview.rows.some((r) => r.kind === "invalid") ? "invalid" : "all",
	);
	const accepted = preview.rows.filter((r) => r.kind === "accepted");
	const repeats = accepted.filter(isRepeat);
	const unchosen = repeats.filter(
		(row) => !skip.has(row.rowNumber) && !keep.has(row.rowNumber),
	).length;
	const count = { duplicate: 0, invalid: 0 };
	for (const r of preview.rows) if (r.kind !== "accepted") count[r.kind]++;
	const shown = preview.rows.filter((r) =>
		filter === "all"
			? true
			: filter === "repeats"
				? isRepeat(r)
				: r.kind === filter,
	);
	const adding = accepted.length - skip.size;
	const allRepeatsSkipped =
		repeats.length > 0 && repeats.every((r) => skip.has(r.rowNumber));
	const toggle = (n: number) => {
		const next = new Set(skip);
		if (repeats.some((row) => row.rowNumber === n)) {
			const chosen = new Set(keep);
			if (chosen.has(n)) {
				chosen.delete(n);
				next.add(n);
			} else {
				chosen.add(n);
				next.delete(n);
			}
			setKeep(chosen);
			onSkip(next);
			return;
		}
		if (next.has(n)) next.delete(n);
		else next.add(n);
		onSkip(next);
	};

	if (preview.alreadyImported !== null)
		return (
			<div className="flex flex-col items-start gap-3">
				<Badge tone="info">Already imported</Badge>
				<p className="text-muted-foreground">
					Import #{preview.alreadyImported} is this exact file. Nothing would
					change.
				</p>
				<Button variant="ghost" onClick={onBack}>
					Back
				</Button>
				<Button onClick={onCorrect}>Correct import</Button>
			</div>
		);

	const tabs: [Filter, string, number][] = [
		["all", "All", preview.rows.length],
		["repeats", "Maybe imported before", repeats.length],
		["duplicate", "Already in", count.duplicate],
		["invalid", "Unreadable", count.invalid],
	];
	return (
		<div className="flex min-h-0 flex-col gap-3">
			<div className="flex flex-wrap items-center gap-1">
				{tabs
					.filter(([k, , n]) => k === "all" || n > 0)
					.map(([k, label, n]) => (
						<button
							key={k}
							type="button"
							onClick={() => setFilter(k)}
							className={cn(
								"h-7 rounded-md px-2.5 text-xs hover:bg-surface-strong",
								filter === k && "bg-card font-medium shadow-card",
								k === "invalid" && "text-critical-text",
							)}
						>
							{label} <span className="tabular-nums">{formatCount(n)}</span>
						</button>
					))}
				{repeats.length > 0 && (
					<Button
						variant="ghost"
						size="xs"
						className="ml-auto"
						disabled={busy || retry}
						onClick={() => {
							const next = new Set(skip);
							const chosen = new Set(keep);
							for (const r of repeats)
								if (allRepeatsSkipped) {
									next.delete(r.rowNumber);
									chosen.add(r.rowNumber);
								} else {
									next.add(r.rowNumber);
									chosen.delete(r.rowNumber);
								}
							setKeep(chosen);
							onSkip(next);
						}}
					>
						{allRepeatsSkipped ? "Keep" : "Leave out"}{" "}
						{formatCount(repeats.length)} maybe imported before
					</Button>
				)}
			</div>
			<div className="min-h-0 overflow-y-auto rounded-lg border">
				<table className="w-full text-sm">
					<tbody>
						{shown.slice(0, SHOWN).map((r) => (
							<PreviewLine
								key={r.rowNumber}
								row={r}
								currency={currency}
								skipped={skip.has(r.rowNumber)}
								kept={keep.has(r.rowNumber)}
								busy={busy || retry}
								onToggle={() => toggle(r.rowNumber)}
							/>
						))}
					</tbody>
				</table>
				{shown.length > SHOWN && (
					<p className="border-t px-3 py-2 text-xs text-muted-foreground">
						and {formatCount(shown.length - SHOWN)} more
					</p>
				)}
			</div>
			<div className="flex items-center gap-3">
				<Button variant="ghost" onClick={onBack} disabled={busy || retry}>
					Change columns
				</Button>
				<Button onClick={() => onImport(keep)} disabled={busy || unchosen > 0}>
					{busy && <Loader2 className="animate-spin" />}
					{retry
						? "Retry import"
						: adding > 0
							? `Import ${formatCount(adding)} ${adding === 1 ? "row" : "rows"}`
							: "Record file, add nothing"}
				</Button>
				{unchosen > 0 && (
					<span className="text-xs text-warning-text">
						Choose {formatCount(unchosen)} possible duplicates
					</span>
				)}
				{problem && (
					<span className="text-xs text-critical-text">{problem}</span>
				)}
			</div>
		</div>
	);
}

function PreviewLine({
	row: r,
	currency,
	skipped,
	kept,
	busy,
	onToggle,
}: {
	row: Row;
	currency: string;
	skipped: boolean;
	kept: boolean;
	busy: boolean;
	onToggle: () => void;
}) {
	if (r.kind === "invalid")
		return (
			<tr className="border-t first:border-t-0">
				<td className="w-12 px-3 py-1.5 text-xs text-muted-foreground tabular-nums">
					{r.rowNumber}
				</td>
				<td colSpan={3} className="px-2 py-1.5">
					<span className="text-critical-text">{r.problem}</span>
					<span className="ml-2 truncate font-mono text-xs text-muted-foreground">
						{r.cells.join(" · ")}
					</span>
				</td>
			</tr>
		);
	const t = r.transaction;
	return (
		<tr
			className={cn(
				"border-t first:border-t-0",
				(skipped || r.kind === "duplicate") &&
					"text-muted-foreground line-through",
			)}
		>
			<td className="w-12 px-3 py-1.5 text-xs text-muted-foreground tabular-nums">
				{r.kind === "accepted" ? (
					<label className="flex items-center gap-1.5">
						<input
							type="checkbox"
							checked={!skipped && (r.repeatOf === null || kept)}
							disabled={busy}
							onChange={onToggle}
							aria-label={`${r.repeatOf === null ? "Keep" : "New transaction"} row ${r.rowNumber}`}
						/>
						{r.rowNumber}
					</label>
				) : (
					r.rowNumber
				)}
			</td>
			<td className="px-2 py-1.5 whitespace-nowrap tabular-nums">
				{t.postedOn}
			</td>
			<td className="max-w-md truncate px-2 py-1.5">
				{t.description}
				{r.kind === "accepted" && r.repeatOf !== null && (
					<span className="ml-2 no-underline">
						<Badge tone="warning">Maybe imported before</Badge>
					</span>
				)}
				{r.kind === "accepted" && r.twinOf !== null && (
					<span className="ml-2">
						<Badge>Same as row {r.twinOf}</Badge>
					</span>
				)}
				{r.kind === "duplicate" && (
					<span className="ml-2">
						<Badge tone="info">Already in</Badge>
					</span>
				)}
			</td>
			<td
				className={cn(
					"px-3 py-1.5 text-right tabular-nums",
					t.amountCents > 0 && "text-success-text",
				)}
			>
				{formatCents(t.amountCents, currency)}
			</td>
		</tr>
	);
}
