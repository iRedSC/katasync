import { useRouter } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatCount, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import type {
	StatementChannel,
	StatementResult,
} from "#/reports/statements/types";
import {
	STATEMENT_BASIS,
	STATEMENT_NAME,
	STATEMENT_TITLE,
	statementCaveat,
	statementView,
} from "#/reports/statements/view";
import { readMarketplaceFigures } from "#/server/reports";

// Each marketplace's own figures for the month, the way its statement or
// sales report shows them, with when they were read and a way to read them
// again.

type Read =
	| { kind: "idle" }
	| { kind: "reading" }
	| { kind: "done" }
	| { kind: "failed"; error: string };

function ago(at: Date, now: number) {
	const minutes = Math.round((now - at.getTime()) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function MarketplaceFigures({
	period,
	statements,
	readAt,
}: {
	period: string;
	statements: StatementResult[];
	readAt: Record<string, Date>;
}) {
	return (
		<div className="grid gap-4 xl:grid-cols-2">
			{statements.map((r) => (
				<Figures
					key={r.channel}
					period={period}
					r={r}
					readAt={readAt[r.channel] ?? null}
				/>
			))}
		</div>
	);
}

function Figures({
	period,
	r,
	readAt,
}: {
	period: string;
	r: StatementResult;
	readAt: Date | null;
}) {
	const router = useRouter();
	const [read, setRead] = useState<Read>({ kind: "idle" });
	// The card glows once when new figures land, then settles.
	useEffect(() => {
		if (read.kind !== "done") return;
		const t = setTimeout(() => setRead({ kind: "idle" }), 1500);
		return () => clearTimeout(t);
	}, [read.kind]);

	async function readAgain(channel: StatementChannel) {
		if (read.kind === "reading") return;
		setRead({ kind: "reading" });
		try {
			const result = await readMarketplaceFigures({
				data: { period, channel },
			});
			await router.invalidate();
			setRead(
				result.kind === "read"
					? { kind: "done" }
					: { kind: "failed", error: result.error },
			);
		} catch (e) {
			setRead({
				kind: "failed",
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	const error =
		read.kind === "failed"
			? read.error
			: r.state === "missing"
				? r.error
				: r.lastError;
	return (
		<Card
			flush
			tone={error ? "critical" : undefined}
			title={
				<span className="flex items-center gap-2">
					<ChannelBadge
						channel={r.channel}
						salesChannel={null}
						label={STATEMENT_NAME[r.channel]}
					/>
					<span className="font-normal text-muted-foreground">
						{STATEMENT_TITLE[r.channel]}
					</span>
				</span>
			}
			aside={
				<span className="flex items-center gap-2 text-muted-foreground">
					{readAt && <span>Read {ago(readAt, Date.now())}</span>}
					<Button
						variant="ghost"
						size="xs"
						onClick={() => readAgain(r.channel)}
						disabled={read.kind === "reading"}
						className={cn(
							read.kind === "failed" && "motion-safe:animate-shake",
						)}
					>
						<RefreshCw
							className={cn(read.kind === "reading" && "animate-spin")}
						/>
						{r.state === "missing" ? "Read now" : "Read again"}
					</Button>
				</span>
			}
		>
			<div
				className={cn(
					"transition-shadow duration-700",
					read.kind === "done" &&
						"shadow-[inset_0_0_0_2px_var(--color-success-border)]",
				)}
			>
				{error && (
					<p className="border-t px-4 py-2 font-medium text-critical-text">
						{error}
					</p>
				)}
				{r.state === "missing" ? (
					!error && (
						<p className="border-t px-4 py-3 text-muted-foreground">
							Not read yet
						</p>
					)
				) : (
					<Body r={r} />
				)}
			</div>
		</Card>
	);
}

function Body({ r }: { r: Extract<StatementResult, { state: "read" }> }) {
	const view = statementView(r.statement);
	const num = "whitespace-nowrap px-4 py-1.5 text-right tabular-nums";
	return (
		<>
			<p className="border-t px-4 py-2 text-muted-foreground">
				{STATEMENT_BASIS[r.channel]}
			</p>
			{statementCaveat(r) && (
				<p className="border-t px-4 py-2 font-medium text-warning-text">
					{statementCaveat(r)}
				</p>
			)}
			<div className="overflow-x-auto">
				{view.kind === "table" ? (
					<table className="w-full">
						<thead className="text-muted-foreground">
							<tr className="border-t">
								<th className="px-4 py-1.5 text-left font-medium">Channel</th>
								{view.columns.map((c) => (
									<th key={c.label} className={cn(num, "font-medium")}>
										{c.label}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{view.rows.map((row) => (
								<tr key={row.label} className="border-t">
									<td className="px-4 py-1.5">{row.label}</td>
									{row.cells.map((n, i) => (
										<td key={view.columns[i].label} className={num}>
											{view.columns[i].count ? formatCount(n) : formatMoney(n)}
										</td>
									))}
								</tr>
							))}
							<tr className="border-t font-semibold">
								<td className="px-4 py-1.5">Total</td>
								{view.total.map((n, i) => (
									<td key={view.columns[i].label} className={num}>
										{view.columns[i].count ? formatCount(n) : formatMoney(n)}
									</td>
								))}
							</tr>
							{view.callouts.map((l) => (
								<tr key={l.label} className="border-t bg-info-surface">
									<td className="px-4 py-1.5 font-medium" colSpan={5}>
										{l.label}
									</td>
									<td
										className={cn(num, "font-semibold")}
										colSpan={view.columns.length - 4}
									>
										{formatMoney(l.amount)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<table className="w-full">
						{view.sections.map((sec, k) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: sections are positional
							<tbody key={k}>
								{sec.title && (
									<tr className="border-t">
										<th
											className="px-4 py-1.5 text-left font-semibold"
											colSpan={2}
										>
											{sec.title}
										</th>
									</tr>
								)}
								{sec.lines.map((l) => (
									<tr key={l.label} className="border-t">
										<td className="px-4 py-1.5">{l.label}</td>
										<td className={num}>{formatMoney(l.amount)}</td>
									</tr>
								))}
								{sec.total && (
									<tr className="border-t font-semibold">
										<td className="px-4 py-1.5">{sec.total.label}</td>
										<td className={num}>{formatMoney(sec.total.amount)}</td>
									</tr>
								)}
							</tbody>
						))}
					</table>
				)}
			</div>
		</>
	);
}
