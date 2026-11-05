import { Link, useRouter } from "@tanstack/react-router";
import {
	Check,
	ChevronDown,
	Download,
	GitCompare,
	Loader2,
	Printer,
	Send,
} from "lucide-react";
import { useState } from "react";
import { Badge, Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "#/components/ui/dialog";
import { Tip } from "#/components/ui/tooltip";
import { formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";
import { type Change, reportChanges } from "#/reports/diff";
import type { ReportData } from "#/reports/snapshot";
import type { LiveState, RevisionView } from "#/reports/store";
import {
	getReportArtifact,
	handOffRevision,
	saveReportRevision,
} from "#/server/reports";
import { downloadText } from "./download";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

type PrintState =
	| { kind: "idle" }
	| { kind: "choosing" }
	| { kind: "saving" }
	| { kind: "failed"; message: string };

// Printing always prints a saved revision. Unchanged figures reprint the
// latest one; new figures save a revision first; when both exist, the
// dialog asks which.
export function PrintButton({
	period,
	revisions,
	live,
	liveState,
}: {
	period: string;
	revisions: RevisionView[];
	live: ReportData;
	liveState: LiveState;
}) {
	const router = useRouter();
	const [state, setState] = useState<PrintState>({ kind: "idle" });
	const [latest] = revisions;
	const href = (snapshot: number) =>
		router.buildLocation({ to: "/print/report", search: { snapshot } }).href;

	function printSaved(snapshot: number) {
		setState({ kind: "idle" });
		window.open(href(snapshot), "_blank");
	}

	async function printNew() {
		if (state.kind === "saving") return;
		// Opened now, while the click still counts, or the browser blocks it.
		const tab = window.open("about:blank", "_blank");
		setState({ kind: "saving" });
		try {
			const result = await saveReportRevision({ data: { period } });
			if (tab) tab.location.href = href(result.id);
			else window.location.assign(href(result.id));
			setState({ kind: "idle" });
			await router.invalidate();
		} catch (e) {
			tab?.close();
			setState({ kind: "failed", message: messageOf(e) });
		}
	}

	function onClick() {
		if (liveState.kind === "saved" && latest) printSaved(latest.id);
		else if (liveState.kind === "changed") setState({ kind: "choosing" });
		else printNew();
	}

	return (
		<>
			{state.kind === "failed" && (
				<span className="text-xs text-critical-text animate-in fade-in">
					{state.message}
				</span>
			)}
			<Button onClick={onClick} disabled={state.kind === "saving"}>
				{state.kind === "saving" ? (
					<Loader2 className="animate-spin" />
				) : (
					<Printer />
				)}
				Print
			</Button>
			{latest && (
				<Dialog
					open={state.kind === "choosing"}
					onOpenChange={(open) => !open && setState({ kind: "idle" })}
				>
					<DialogContent className="sm:max-w-xl">
						<DialogTitle>Print which?</DialogTitle>
						<DialogDescription className="sr-only">
							The figures changed since revision {latest.revision} was printed
						</DialogDescription>
						<div className="grid grid-cols-2 gap-2">
							<button
								type="button"
								onClick={() => printSaved(latest.id)}
								className="flex flex-col items-start gap-0.5 rounded-lg border p-3 text-left hover:bg-surface"
							>
								<span className="font-semibold">
									Revision {latest.revision}
								</span>
								<span className="text-xs text-muted-foreground tabular-nums">
									{formatDateTime(latest.asOf)}
								</span>
							</button>
							<button
								type="button"
								onClick={printNew}
								className="flex flex-col items-start gap-0.5 rounded-lg border border-primary bg-primary/5 p-3 text-left hover:bg-primary/10"
							>
								<span className="font-semibold">
									Revision {latest.revision + 1}
								</span>
								<span className="text-xs text-muted-foreground">Now</span>
							</button>
						</div>
						<div className="max-h-72 overflow-y-auto">
							<Changes changes={reportChanges(latest.data, live)} />
						</div>
					</DialogContent>
				</Dialog>
			)}
		</>
	);
}

// Every revision printed for the month, newest first, folded away until
// asked for.
export function History({
	revisions,
	live,
	liveState,
}: {
	revisions: RevisionView[];
	live: ReportData;
	liveState: LiveState;
}) {
	const [open, setOpen] = useState(false);
	if (revisions.length === 0) return null;
	const lastRecipient = revisions
		.flatMap((r) => r.handoffs)
		.sort((a, b) => +b.handedAt - +a.handedAt)[0]?.recipient;

	return (
		<Card
			title="History"
			aside={
				<Button size="xs" variant="ghost" onClick={() => setOpen(!open)}>
					{revisions.length} printed
					<ChevronDown
						className={cn("transition-transform", open && "rotate-180")}
					/>
				</Button>
			}
			flush
		>
			{open && (
				<ul className="flex flex-col animate-in fade-in">
					{revisions.map((r, i) => (
						<RevisionRow
							key={r.id}
							revision={r}
							previous={revisions[i + 1]?.data ?? null}
							live={i === 0 && liveState.kind === "changed" ? live : null}
							lastRecipient={lastRecipient}
						/>
					))}
				</ul>
			)}
		</Card>
	);
}

type Handoff =
	| { kind: "closed" }
	| { kind: "open"; recipient: string; note: string; error?: string }
	| { kind: "sending"; recipient: string; note: string };

function RevisionRow({
	revision: r,
	previous,
	live,
	lastRecipient,
}: {
	revision: RevisionView;
	previous: ReportData | null;
	live: ReportData | null;
	lastRecipient: string | undefined;
}) {
	const router = useRouter();
	const [diff, setDiff] = useState<"none" | "previous" | "live">("none");
	const [handoff, setHandoff] = useState<Handoff>({ kind: "closed" });
	const [fileError, setFileError] = useState<string | null>(null);
	const [fetching, setFetching] = useState<string | null>(null);
	const handedOff = r.handoffs.length > 0;
	const superseded = r.state.kind === "superseded";

	async function download(name: string) {
		if (fetching) return;
		setFetching(name);
		setFileError(null);
		try {
			const f = await getReportArtifact({
				data: { snapshotId: r.id, name },
			});
			downloadText(f.filename, f.content, f.mediaType);
		} catch (e) {
			setFileError(messageOf(e));
		} finally {
			setFetching(null);
		}
	}

	async function submit() {
		if (handoff.kind !== "open") return;
		if (!handoff.recipient.trim()) {
			setHandoff({ ...handoff, error: "Who to?" });
			return;
		}
		setHandoff({ ...handoff, kind: "sending" });
		try {
			await handOffRevision({
				data: {
					snapshotId: r.id,
					digest: r.digest,
					recipient: handoff.recipient,
					note: handoff.note || null,
				},
			});
			await router.invalidate();
			setHandoff({ kind: "closed" });
		} catch (e) {
			setHandoff({ ...handoff, kind: "open", error: messageOf(e) });
		}
	}

	const changes =
		diff === "previous" && previous
			? reportChanges(previous, r.data)
			: diff === "live" && live
				? reportChanges(r.data, live)
				: null;

	return (
		<li
			className={cn(
				"flex flex-col gap-2 border-t px-4 py-3",
				superseded && "text-muted-foreground",
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-semibold text-foreground">
					Revision {r.revision}
				</span>
				<span className="tabular-nums">{formatDateTime(r.asOf)}</span>
				<Tip content={`sha256 ${r.digest}`}>
					<code className="rounded bg-surface px-1 text-xs">
						{r.digest.slice(0, 12)}
					</code>
				</Tip>
				{r.state.kind === "superseded" && (
					<Badge>Superseded by {r.state.by}</Badge>
				)}
				{handedOff && superseded && (
					<Badge tone="critical">Revised after handoff</Badge>
				)}
				{r.handoffs.map((h) => (
					<Badge key={`${+h.handedAt}|${h.recipient}`} tone="success">
						<Check className="mr-1 size-3" />
						{h.recipient}, {formatDateTime(h.handedAt)}
					</Badge>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-1">
				<Link
					to="/print/report"
					search={{ snapshot: r.id }}
					target="_blank"
					className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs hover:bg-surface-strong"
				>
					<Printer className="size-3" />
					Print
				</Link>
				{r.files
					.filter((f) => f.name.endsWith(".csv"))
					.map((f) => (
						<Tip key={f.name} content={`${f.bytes} bytes, sha256 ${f.sha256}`}>
							<Button
								size="xs"
								variant="ghost"
								onClick={() => download(f.name)}
							>
								{fetching === f.name ? (
									<Loader2 className="animate-spin" />
								) : (
									<Download />
								)}
								{f.name}
							</Button>
						</Tip>
					))}
				{previous && (
					<Button
						size="xs"
						variant={diff === "previous" ? "secondary" : "ghost"}
						onClick={() => setDiff(diff === "previous" ? "none" : "previous")}
					>
						<GitCompare />
						Since revision {r.revision - 1}
					</Button>
				)}
				{live && (
					<Button
						size="xs"
						variant={diff === "live" ? "secondary" : "ghost"}
						onClick={() => setDiff(diff === "live" ? "none" : "live")}
					>
						<GitCompare />
						Since printed
					</Button>
				)}
				{handoff.kind === "closed" && (
					<Button
						size="xs"
						variant="ghost"
						onClick={() =>
							setHandoff({
								kind: "open",
								recipient: lastRecipient ?? "",
								note: "",
							})
						}
					>
						<Send />
						Hand off
					</Button>
				)}
			</div>
			{fileError && <p className="text-xs text-critical-text">{fileError}</p>}
			{handoff.kind !== "closed" && (
				<form
					className="flex flex-wrap items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<input
						value={handoff.recipient}
						onChange={(e) =>
							handoff.kind === "open" &&
							setHandoff({
								...handoff,
								recipient: e.target.value,
								error: undefined,
							})
						}
						placeholder="To"
						className={cn(
							"h-7 w-48 rounded-md bg-white px-2 text-foreground shadow-card outline-none",
							handoff.kind === "open" &&
								handoff.error &&
								"ring-2 ring-critical-icon",
						)}
					/>
					<input
						value={handoff.note}
						onChange={(e) =>
							handoff.kind === "open" &&
							setHandoff({ ...handoff, note: e.target.value })
						}
						placeholder="Note"
						className="h-7 min-w-0 flex-1 rounded-md bg-white px-2 text-foreground shadow-card outline-none"
					/>
					<Button size="xs" type="submit" disabled={handoff.kind === "sending"}>
						{handoff.kind === "sending" ? (
							<Loader2 className="animate-spin" />
						) : (
							<Check />
						)}
						Revision {r.revision}
					</Button>
					<Button
						size="xs"
						variant="ghost"
						type="button"
						onClick={() => setHandoff({ kind: "closed" })}
					>
						Cancel
					</Button>
					{handoff.kind === "open" && handoff.error && (
						<span className="text-xs text-critical-text">{handoff.error}</span>
					)}
				</form>
			)}
			{changes && <Changes changes={changes} />}
		</li>
	);
}

const fieldName = (field: string) =>
	field
		.replaceAll(".", " ")
		.replaceAll("_", " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase();

const shown = (v: Change["before"]) =>
	v === undefined ? "none" : v === null ? "blank" : String(v);

function Changes({ changes }: { changes: Change[] }) {
	if (changes.length === 0)
		return <p className="text-xs text-muted-foreground">Same figures</p>;
	return (
		<table className="w-full text-xs tabular-nums">
			<tbody>
				{changes.map((c) => (
					<tr
						key={`${c.section}|${c.row}|${c.field}`}
						className="border-t text-foreground"
					>
						<td className="py-1 pr-2 text-muted-foreground">{c.section}</td>
						<td className="py-1 pr-2">{c.row}</td>
						<td className="py-1 pr-2">{fieldName(c.field)}</td>
						<td className="py-1 pr-2 text-right line-through text-muted-foreground">
							{shown(c.before)}
						</td>
						<td className="py-1 text-right font-semibold">{shown(c.after)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
