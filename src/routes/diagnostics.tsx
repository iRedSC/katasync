import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	AlertCircle,
	AlertTriangle,
	CheckCircle2,
	Copy,
	Loader2,
	PlayCircle,
	RotateCcw,
	X,
	XCircle,
} from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Badge, Card, Page, type Tone } from "#/components/page";
import {
	DOT,
	PanelHeader,
	SidePanel,
	Tile,
	TileGrid,
} from "#/components/panel";
import { FieldsCard, ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { Tip } from "#/components/ui/tooltip";
import type { CheckTarget } from "#/diagnostics/checks";
import type { DismissTarget } from "#/diagnostics/dismissals";
import type { Health, Hint } from "#/diagnostics/health";
import { channelName, formatCount, formatDateTime } from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import {
	type Diagnostics,
	dismissProblem,
	getDiagnostics,
	restoreProblem,
	runConnectionCheck,
} from "#/server/diagnostics";
import { resendTracking, retryStorefront } from "#/server/shipping";

export const Route = createFileRoute("/diagnostics")({
	loader: () => getDiagnostics(),
	component: DiagnosticsPage,
	pendingComponent: () => (
		<ListSkeleton title="Diagnostics">
			<ListCard rows={4} />
			<FieldsCard lines={4} />
		</ListSkeleton>
	),
});

const diagnosticsData = optimistic<Diagnostics>("diagnostics");

const HEALTH: Record<Health, { label: string; tone?: Tone }> = {
	healthy: { label: "Healthy", tone: "success" },
	degraded: { label: "Some orders failing", tone: "warning" },
	failing: { label: "Sync failing", tone: "critical" },
	stale: { label: "No recent sync", tone: "warning" },
	never_synced: { label: "Never synced" },
	not_connected: { label: "Not connected" },
};

function ago(at: Date | string | null) {
	if (!at) return "never";
	const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function copy(text: string) {
	navigator.clipboard.writeText(text).then(() => toast.success("Copied"));
}

// Errors can be pretty-printed JSON; a row has one line for them.
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// The worker being down stops everything else on the page, so it sits in the
// header, opening to what to run.
function SyncStopped({ lastStartedAt }: { lastStartedAt: Date | null }) {
	return (
		<Popover>
			<PopoverTrigger className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-critical-fill px-2.5 font-medium text-critical-text">
				<AlertCircle className="size-4" />
				Order sync stopped
			</PopoverTrigger>
			<PopoverContent className="w-80 p-3">
				<p>
					{lastStartedAt
						? `Last sync ${formatDateTime(lastStartedAt)}. `
						: "Never synced. "}
					On the katasync machine, run:
				</p>
				<button
					type="button"
					onClick={() => copy("pnpm sync --watch")}
					className="mt-2 w-full rounded-md bg-subtle px-2 py-1 text-left font-mono hover:bg-surface-strong"
				>
					pnpm sync --watch
				</button>
			</PopoverContent>
		</Popover>
	);
}

function DiagnosticsPage() {
	const d = diagnosticsData.useData("all", Route.useLoaderData());
	const router = useRouter();
	const [sheet, setSheet] = useState<CheckTarget | null>(null);

	return (
		<Page
			title="Diagnostics"
			actions={
				<>
					{!d.worker.alive && (
						<SyncStopped lastStartedAt={d.worker.lastStartedAt} />
					)}
					<Button
						variant="outline"
						size="sm"
						onClick={() => router.invalidate()}
					>
						Refresh
					</Button>
				</>
			}
		>
			<Connections d={d} open={setSheet} />
			<Problems d={d} open={setSheet} />
			<AgentChanges calls={d.claude} />
			<Sheet d={d} target={sheet} onClose={() => setSheet(null)} />
		</Page>
	);
}

// Connections

type ChannelData = Diagnostics["channels"][number];

function channelDetail(c: ChannelData) {
	switch (c.health) {
		case "healthy":
		case "degraded":
			return `Synced ${ago(c.lastSuccessAt)}`;
		case "failing":
			return `Failing since ${ago(c.failingSince)}`;
		case "stale":
			return `Last sync ${ago(c.lastSuccessAt)}`;
		default:
			return HEALTH[c.health].label;
	}
}

function shippoStatus(s: Diagnostics["services"]["shippo"]) {
	if (!s.configured) return { label: "Not set up", tone: "warning" as const };
	if (s.test) return { label: "Test key", tone: "warning" as const };
	return { label: "Live", tone: "success" as const };
}

function emailStatus(s: Diagnostics["services"]["email"]) {
	return s.configured
		? { label: "Set up", tone: "success" as const }
		: { label: "Not set up", tone: "warning" as const };
}

function Connections({
	d,
	open,
}: {
	d: Diagnostics;
	open: (target: CheckTarget) => void;
}) {
	const shippo = shippoStatus(d.services.shippo);
	const email = emailStatus(d.services.email);
	return (
		<TileGrid>
			{d.channels.map((c) => (
				<Tile
					key={c.channel}
					name={channelName(c.channel)}
					status={HEALTH[c.health].tone ?? "neutral"}
					detail={channelDetail(c)}
					onClick={() => open(c.channel)}
				/>
			))}
			<Tile
				name="Shippo"
				status={shippo.tone}
				detail={shippo.label}
				onClick={() => open("shippo")}
			/>
			<Tile
				name="PO email"
				status={email.tone}
				detail={email.label}
				onClick={() => open("email")}
			/>
		</TileGrid>
	);
}

// Problems: one list of everything that needs someone, each row with what
// can be done about it.

type Problem =
	| { kind: "sync"; channel: ChannelData }
	| { kind: "handoff"; row: Diagnostics["handoffs"][number] }
	| { kind: "storefront"; row: Diagnostics["storefrontTracking"][number] }
	| { kind: "charges"; row: Diagnostics["charges"][number] }
	| {
			kind: "issue";
			channel: ChannelData["channel"];
			group: ChannelData["issues"][number];
	  };

const GROUPS = {
	sync: "Sync",
	tracking: "Tracking",
	fees: "Fees",
	orders: "Orders",
} as const;
type Group = keyof typeof GROUPS;
type Filter = Group | "all" | "dismissed";

function groupOf(p: Problem): Group {
	switch (p.kind) {
		case "sync":
			return "sync";
		case "handoff":
		case "storefront":
			return "tracking";
		case "charges":
			return "fees";
		case "issue":
			return "orders";
	}
}

function isDismissed(p: Problem) {
	switch (p.kind) {
		case "sync":
			return false;
		case "issue":
			return p.group.dismissed;
		default:
			return p.row.dismissed;
	}
}

// Sync failing goes away only when a pass works, so it can't be dismissed.
function targetOf(p: Problem): DismissTarget | null {
	switch (p.kind) {
		case "sync":
			return null;
		case "handoff":
			return {
				kind: "handoff",
				dispatchId: p.row.dispatchId,
				orderId: p.row.orderId,
			};
		case "storefront":
			return { kind: "storefront", shipmentId: p.row.shipmentId };
		case "charges":
			return {
				kind: "charges",
				billedBy: p.row.billedBy,
				error: p.row.error,
			};
		case "issue":
			return { kind: "issue", channel: p.channel, message: p.group.message };
	}
}

function problemsOf(d: Diagnostics): Problem[] {
	return [
		...d.channels
			.filter(
				(c) =>
					c.health === "failing" || (d.worker.alive && c.health === "stale"),
			)
			.map((channel) => ({ kind: "sync" as const, channel })),
		...d.handoffs.map((row) => ({ kind: "handoff" as const, row })),
		...d.storefrontTracking.map((row) => ({
			kind: "storefront" as const,
			row,
		})),
		...d.charges.map((row) => ({ kind: "charges" as const, row })),
		...d.channels.flatMap((c) =>
			c.issues
				.filter((group) => !group.unmatched)
				.map((group) => ({
					kind: "issue" as const,
					channel: c.channel,
					group,
				})),
		),
	];
}

// Marks what a target covers on the page, until the reload shows it.
function setDismissed(
	d: Diagnostics,
	t: DismissTarget,
	dismissed: boolean,
): Diagnostics {
	switch (t.kind) {
		case "handoff":
			return {
				...d,
				handoffs: d.handoffs.map((r) =>
					r.dispatchId === t.dispatchId && r.orderId === t.orderId
						? { ...r, dismissed }
						: r,
				),
			};
		case "storefront":
			return {
				...d,
				storefrontTracking: d.storefrontTracking.map((r) =>
					r.shipmentId === t.shipmentId ? { ...r, dismissed } : r,
				),
			};
		case "charges":
			return {
				...d,
				charges: merge(
					d.charges.map((r) =>
						r.billedBy === t.billedBy && r.error === t.error
							? { ...r, dismissed }
							: r,
					),
					(r) => `${r.billedBy} ${r.error} ${r.dismissed}`,
					(a, b) => ({
						...a,
						orders: a.orders + b.orders,
						lastAt: a.lastAt > b.lastAt ? a.lastAt : b.lastAt,
					}),
				),
			};
		case "issue":
			return {
				...d,
				channels: d.channels.map((c) =>
					c.channel === t.channel
						? {
								...c,
								issues: merge(
									c.issues.map((g) =>
										g.message === t.message ? { ...g, dismissed } : g,
									),
									(g) => `${g.message} ${g.dismissed}`,
									(a, b) => ({
										...a,
										count: a.count + b.count,
										references: [...a.references, ...b.references],
									}),
								),
							}
						: c,
				),
			};
	}
}

// A group split into dismissed and not becomes one again once it's all
// dismissed (or all restored).
function merge<T>(rows: T[], id: (row: T) => string, add: (a: T, b: T) => T) {
	const byId = new Map<string, T>();
	for (const row of rows) {
		const seen = byId.get(id(row));
		byId.set(id(row), seen ? add(seen, row) : row);
	}
	return [...byId.values()];
}

function setDismissedNow(target: DismissTarget, dismissed: boolean) {
	return optimism.change({
		label: dismissed ? "Dismissing" : "Restoring",
		patch: diagnosticsData.patch("all", (d) =>
			setDismissed(d, target, dismissed),
		),
		send: (): Promise<unknown> =>
			dismissed
				? dismissProblem({ data: { target } })
				: restoreProblem({ data: { target } }),
	});
}

async function dismissNow(target: DismissTarget) {
	const r = await setDismissedNow(target, true);
	if (!r) return;
	toast("Dismissed", {
		action: { label: "Undo", onClick: () => setDismissedNow(target, false) },
	});
}

function Problems({
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

function problemKey(p: Problem) {
	switch (p.kind) {
		case "sync":
			return `sync:${p.channel.channel}`;
		case "handoff":
			return `handoff:${p.row.dispatchId}:${p.row.orderId}`;
		case "storefront":
			return `storefront:${p.row.shipmentId}`;
		case "charges":
			return `charges:${p.row.billedBy}:${p.row.error}`;
		case "issue":
			return `issue:${p.channel}:${p.group.message}`;
	}
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

function OrderLink({ id, name }: { id: number; name: string }) {
	return (
		<Link
			to="/orders/$id"
			params={{ id: String(id) }}
			className="hover:underline"
		>
			{name}
		</Link>
	);
}

function describe(
	p: Problem,
	open: (target: CheckTarget) => void,
): {
	tone: Tone;
	title: ReactNode;
	detail: string;
	at: string | null;
	action: ReactNode;
} {
	switch (p.kind) {
		case "sync": {
			const c = p.channel;
			const name = channelName(c.channel);
			const details = (
				<Button size="sm" variant="outline" onClick={() => open(c.channel)}>
					Details
				</Button>
			);
			return c.health === "failing"
				? {
						tone: "critical",
						title: `${name} sync failing`,
						detail: c.latestError ?? "",
						at: `since ${ago(c.failingSince)}`,
						action: details,
					}
				: {
						tone: "warning",
						title: `${name} not syncing`,
						detail: `Last good sync ${ago(c.lastSuccessAt)}`,
						at: null,
						action: details,
					};
		}
		case "handoff":
			return {
				tone: "critical",
				title: (
					<>
						<OrderLink id={p.row.orderId} name={p.row.orderName} /> tracking not
						sent to {channelName(p.row.channel)}
					</>
				),
				detail: p.row.error ?? "",
				at: ago(p.row.createdAt),
				action: (
					<RetryButton
						send={() =>
							resendTracking({ data: { dispatchId: p.row.dispatchId } })
						}
					/>
				),
			};
		case "storefront":
			return {
				tone: "warning",
				title: (
					<>
						<OrderLink id={p.row.orderId} name={p.row.orderName} /> storefront
						tracking not {p.row.voided ? "removed" : "saved"}
					</>
				),
				detail: p.row.error,
				at: ago(p.row.createdAt),
				action: (
					<RetryButton
						send={() => retryStorefront({ data: { id: p.row.shipmentId } })}
					/>
				),
			};
		case "charges":
			return {
				tone: "warning",
				title: `${channelName(p.row.billedBy)} fees unread on ${formatCount(p.row.orders)} ${p.row.orders === 1 ? "order" : "orders"}`,
				detail: p.row.error,
				at: ago(p.row.lastAt),
				action: null,
			};
		case "issue": {
			const g = p.group;
			const more = g.count - g.references.length;
			return {
				tone: "warning",
				title: `${channelName(p.channel)}: ${g.message}`,
				detail: `${formatCount(g.count)} ${g.count === 1 ? "order" : "orders"}${g.references.length > 0 ? `: ${g.references.join(", ")}${more > 0 ? `, +${formatCount(more)}` : ""}` : ""}`,
				at: null,
				action: null,
			};
		}
	}
}

// Sending is outside the app, so the button waits for the server and the
// reload.
function RetryButton({
	send,
}: {
	send: () => Promise<{ sent: boolean; message: string }>;
}) {
	const [busy, setBusy] = useState(false);
	async function retry() {
		setBusy(true);
		const r = await optimism.change({ send });
		setBusy(false);
		if (!r) return;
		if (r.value.sent) toast.success(r.value.message);
		else toast.error(r.value.message);
	}
	return (
		<Button size="sm" variant="outline" disabled={busy} onClick={retry}>
			{busy && <Loader2 className="animate-spin" />}
			Retry
		</Button>
	);
}

// Details of one connection, from the side.

function Sheet({
	d,
	target,
	onClose,
}: {
	d: Diagnostics;
	target: CheckTarget | null;
	onClose: () => void;
}) {
	const channel = d.channels.find((c) => c.channel === target);
	return (
		<SidePanel open={target !== null} onClose={onClose}>
			{channel ? (
				<ChannelDetail c={channel} />
			) : target === "shippo" ? (
				<ServiceDetail
					name="Shippo"
					target="shippo"
					status={shippoStatus(d.services.shippo)}
					detail={
						d.services.shippo.configured ? null : "SHIPPO_API_KEY not set."
					}
				/>
			) : target === "email" ? (
				<ServiceDetail
					name="PO email"
					target="email"
					status={emailStatus(d.services.email)}
					detail={
						d.services.email.configured
							? `Sends as ${d.services.email.from}`
							: "RESEND_API_KEY and PO_EMAIL_FROM not set."
					}
				/>
			) : null}
		</SidePanel>
	);
}

function ChannelDetail({ c }: { c: ChannelData }) {
	return (
		<>
			<PanelHeader title={channelName(c.channel)} status={HEALTH[c.health]}>
				<CheckButton target={c.channel} />
			</PanelHeader>
			<Facts>
				<Fact label="Last good sync">
					{c.lastSuccessAt
						? `${formatDateTime(c.lastSuccessAt)} (${ago(c.lastSuccessAt)})`
						: "Never"}
				</Fact>
				{c.consecutiveFailures > 0 && c.failingSince && (
					<Fact label="Failing since">
						<span className="text-critical-text">
							{formatDateTime(c.failingSince)}, {c.consecutiveFailures}{" "}
							{c.consecutiveFailures === 1 ? "pass" : "passes"}
						</span>
					</Fact>
				)}
				{c.missing.length > 0 && (
					<Fact label="Missing">
						<span className="font-mono text-xs">{c.missing.join(", ")}</span>
					</Fact>
				)}
			</Facts>
			{c.latestError && (
				<ErrorBlock title="Latest error" text={c.latestError} />
			)}
			{c.hint && <HintBlock hint={c.hint} />}
			<CheckResults target={c.channel} />
			{c.runs.length > 0 && <RunTable runs={c.runs} />}
		</>
	);
}

function ServiceDetail({
	name,
	target,
	status,
	detail,
}: {
	name: string;
	target: CheckTarget;
	status: { label: string; tone?: Tone };
	detail: string | null;
}) {
	return (
		<>
			<PanelHeader title={name} status={status}>
				<CheckButton target={target} />
			</PanelHeader>
			{detail && <p className="text-muted-foreground">{detail}</p>}
			<CheckResults target={target} />
		</>
	);
}

function RunTable({ runs }: { runs: ChannelData["runs"] }) {
	return (
		<table className="w-full">
			<thead>
				<tr className="text-left text-xs text-muted-foreground">
					<th className="py-1 pr-3 font-medium">Pass</th>
					<th className="py-1 pr-3 font-medium">Result</th>
					<th className="py-1 pr-3 text-right font-medium">Orders</th>
					<th className="py-1 font-medium">Detail</th>
				</tr>
			</thead>
			<tbody>
				{runs.map((r) => {
					const result =
						r.finishedAt === null
							? { label: "Running", tone: "info" as const }
							: r.error
								? { label: "Failed", tone: "critical" as const }
								: r.problems > 0
									? { label: "Problems", tone: "warning" as const }
									: { label: "OK", tone: "success" as const };
					return (
						<tr key={r.id} className="border-t align-top">
							<td className="py-1.5 pr-3 whitespace-nowrap">
								{formatDateTime(r.startedAt)}
							</td>
							<td className="py-1.5 pr-3">
								<Badge tone={result.tone}>{result.label}</Badge>
							</td>
							<td className="py-1.5 pr-3 text-right tabular-nums">
								{formatCount(r.orders)}
							</td>
							<td className="max-w-0 truncate py-1.5 font-mono text-xs text-muted-foreground">
								{r.error ??
									(r.problems > 0 ? `${formatCount(r.problems)} problems` : "")}
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

// Live check results, kept per target outside React so they outlive the
// sheet closing.
type CheckResult = Awaited<ReturnType<typeof runConnectionCheck>>;
const results = new Map<CheckTarget, CheckResult>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function useCheck(target: CheckTarget) {
	const result = useSyncExternalStore(
		subscribe,
		() => results.get(target),
		() => undefined,
	);
	const [running, setRunning] = useState(false);
	async function run() {
		setRunning(true);
		// The result shows as soon as the server answers; the reload comes after.
		await optimism.change({
			send: async () => {
				const r = await runConnectionCheck({ data: { target } }).catch(
					(err: unknown) => {
						throw new Error(
							`Check failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					},
				);
				results.set(target, r);
				for (const listener of listeners) listener();
				return r;
			},
		});
		setRunning(false);
	}
	return { result, running, run };
}

function CheckButton({ target }: { target: CheckTarget }) {
	const { running, run } = useCheck(target);
	return (
		<Button size="sm" variant="outline" disabled={running} onClick={run}>
			{running ? <Loader2 className="animate-spin" /> : <PlayCircle />}
			Run check
		</Button>
	);
}

function CheckResults({ target }: { target: CheckTarget }) {
	const { result } = useCheck(target);
	if (!result) return null;
	return (
		<div className="rounded-lg border p-3">
			<p className="mb-2 font-medium">
				Check, {new Date(result.ranAt).toLocaleTimeString()}
			</p>
			<ol className="flex flex-col gap-1.5">
				{result.steps.map((step) => (
					<li key={step.label} className="flex gap-2">
						{step.status === "ok" ? (
							<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-icon" />
						) : step.status === "warn" ? (
							<AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-icon" />
						) : (
							<XCircle className="mt-0.5 size-4 shrink-0 text-critical-icon" />
						)}
						<div className="min-w-0">
							<span className="font-medium">{step.label}</span>{" "}
							<span className="text-xs text-muted-foreground">{step.ms}ms</span>
							<p
								className={cn(
									"font-mono text-xs break-words",
									step.status === "fail"
										? "text-critical-text"
										: "text-muted-foreground",
								)}
							>
								{step.detail}
							</p>
						</div>
					</li>
				))}
			</ol>
		</div>
	);
}

function Facts({ children }: { children: ReactNode }) {
	return (
		<dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1">{children}</dl>
	);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd>{children}</dd>
		</>
	);
}

function ErrorBlock({ title, text }: { title: string; text: string }) {
	return (
		<div className="rounded-lg border border-critical-border bg-critical-surface p-3">
			<div className="mb-1 flex items-center justify-between font-medium text-critical-text">
				{title}
				<Tip content="Copy">
					<button type="button" aria-label="Copy" onClick={() => copy(text)}>
						<Copy className="size-3.5" />
					</button>
				</Tip>
			</div>
			<pre className="max-h-48 overflow-auto font-mono text-xs break-words whitespace-pre-wrap">
				{text}
			</pre>
		</div>
	);
}

function HintBlock({ hint }: { hint: Hint }) {
	return (
		<div className="rounded-lg border border-info-border bg-info-surface p-3">
			<p className="font-medium">{hint.title}</p>
			<p className="text-muted-foreground">{hint.action}</p>
		</div>
	);
}

// What agents changed through /mcp, newest first. Arguments are what it
// asked for; the result is what katasync answered.
const AGENT_ROWS = 8;

function AgentChanges({ calls }: { calls: Diagnostics["claude"] }) {
	const [open, setOpen] = useState<number | null>(null);
	const [all, setAll] = useState(false);
	const shown = all ? calls : calls.slice(0, AGENT_ROWS);
	return (
		<Card title="Agent changes" flush>
			{calls.length === 0 ? (
				<p className="px-4 pb-4 text-muted-foreground">None yet.</p>
			) : (
				<ul>
					{shown.map((c) => (
						<li key={c.id} className="border-t">
							<button
								type="button"
								onClick={() => setOpen(open === c.id ? null : c.id)}
								className="grid w-full grid-cols-[9rem_10rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-left hover:bg-subtle"
							>
								<span className="whitespace-nowrap text-muted-foreground">
									{formatDateTime(c.createdAt)}
								</span>
								<span className="truncate font-mono text-xs">{c.tool}</span>
								<span className="truncate font-mono text-xs text-muted-foreground">
									{c.arguments}
								</span>
								<Badge tone={c.ok ? "success" : "critical"}>
									{c.ok ? "Done" : "Failed"}
								</Badge>
							</button>
							{open === c.id && (
								<div className="flex flex-col gap-2 px-4 pb-3">
									<p className="text-xs text-muted-foreground">
										Token: {c.tokenName}
									</p>
									<pre className="max-h-48 overflow-auto rounded-lg bg-subtle p-2 font-mono text-xs break-words whitespace-pre-wrap">
										{JSON.stringify(JSON.parse(c.arguments), null, 1)}
									</pre>
									<pre
										className={cn(
											"max-h-48 overflow-auto rounded-lg p-2 font-mono text-xs break-words whitespace-pre-wrap",
											c.ok
												? "bg-subtle"
												: "bg-critical-surface text-critical-text",
										)}
									>
										{c.result}
									</pre>
								</div>
							)}
						</li>
					))}
					{calls.length > AGENT_ROWS && (
						<li className="border-t">
							<button
								type="button"
								onClick={() => setAll((a) => !a)}
								className="w-full px-4 py-2 text-left text-link hover:bg-subtle"
							>
								{all ? "Show fewer" : `Show all ${formatCount(calls.length)}`}
							</button>
						</li>
					)}
				</ul>
			)}
		</Card>
	);
}
