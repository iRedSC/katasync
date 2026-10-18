import { RotateCcw, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Card } from "#/components/page";
import { DOT } from "#/components/panel";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import type { CheckTarget } from "#/diagnostics/checks";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Diagnostics } from "#/server/diagnostics";
import { describe } from "./problem-describe";
import {
	dismissNow,
	type Filter,
	GROUPS,
	type Group,
	groupOf,
	isDismissed,
	type Problem,
	problemKey,
	problemsOf,
	setDismissedNow,
	targetOf,
} from "./problems";

// Errors can be pretty-printed JSON; a row has one line for them.
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function Problems({
	d,
	open,
}: {
	d: Diagnostics;
	open: (target: CheckTarget) => void;
}) {
	const [filter, setFilter] = useState<Filter>("all");
	const all = problemsOf(d);
	const active = all.filter((p) => !isDismissed(p));
	const dismissed = all.filter(isDismissed);
	const counts = Object.fromEntries(
		(Object.keys(GROUPS) as Group[]).map((g) => [
			g,
			active.filter((p) => groupOf(p) === g).length,
		]),
	) as Record<Group, number>;
	// A filter left empty (its last row dismissed) falls back to everything.
	const shown: Filter =
		filter === "all" ||
		(filter === "dismissed" ? dismissed.length > 0 : counts[filter] > 0)
			? filter
			: "all";
	const rows =
		shown === "all"
			? active
			: shown === "dismissed"
				? dismissed
				: active.filter((p) => groupOf(p) === shown);

	return (
		<Card
			title={`Needs you${active.length > 0 ? ` · ${formatCount(active.length)}` : ""}`}
			flush
			aside={
				<div className="flex items-center gap-1">
					{(Object.keys(GROUPS) as Group[])
						.filter((g) => counts[g] > 0)
						.map((g) => (
							<Chip
								key={g}
								on={shown === g}
								onClick={() => setFilter(shown === g ? "all" : g)}
							>
								{GROUPS[g]} {formatCount(counts[g])}
							</Chip>
						))}
					{dismissed.length > 0 && (
						<Chip
							on={shown === "dismissed"}
							onClick={() =>
								setFilter(shown === "dismissed" ? "all" : "dismissed")
							}
						>
							Dismissed {formatCount(dismissed.length)}
						</Chip>
					)}
				</div>
			}
		>
			{rows.length === 0 ? (
				<p className="px-4 pb-4 text-muted-foreground">Nothing needs you.</p>
			) : (
				<ul>
					{rows.map((p) => (
						<ProblemRow
							key={`${problemKey(p)}:${isDismissed(p)}`}
							problem={p}
							open={open}
						/>
					))}
				</ul>
			)}
		</Card>
	);
}

function Chip({
	on,
	onClick,
	children,
}: {
	on: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"h-6 rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
				on
					? "bg-foreground text-background"
					: "text-muted-foreground hover:bg-surface-strong",
			)}
		>
			{children}
		</button>
	);
}

function ProblemRow({
	problem: p,
	open,
}: {
	problem: Problem;
	open: (target: CheckTarget) => void;
}) {
	const target = targetOf(p);
	const dismissed = isDismissed(p);
	const { tone, title, detail, at, action } = describe(p, open);
	return (
		<li className="grid grid-cols-[0.5rem_minmax(0,1fr)_auto_2rem] items-center gap-3 border-t px-4 py-2.5">
			<span className={cn("size-2 rounded-full", DOT[tone])} />
			<div className="min-w-0">
				<p className="truncate font-medium">{title}</p>
				<Tip content={detail}>
					<p className="truncate text-xs text-muted-foreground">
						<span className="font-mono">{oneLine(detail)}</span>
						{at && ` · ${at}`}
					</p>
				</Tip>
			</div>
			<div className="justify-self-end">{!dismissed && action}</div>
			<div className="flex justify-center">
				{target && (
					<Tip content={dismissed ? "Restore" : "Dismiss"}>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={dismissed ? "Restore" : "Dismiss"}
							onClick={() =>
								dismissed ? setDismissedNow(target, false) : dismissNow(target)
							}
						>
							{dismissed ? <RotateCcw /> : <X />}
						</Button>
					</Tip>
				)}
			</div>
		</li>
	);
}
