import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Copy,
	Loader2,
	PlayCircle,
	XCircle,
} from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Badge, Banner, Card, Page, type Tone } from "#/components/page";
import { Button } from "#/components/ui/button";
import type { CheckTarget } from "#/diagnostics/checks";
import type { Health, Hint } from "#/diagnostics/health";
import { channelName, formatCount, formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";
import {
	type Diagnostics,
	getDiagnostics,
	runConnectionCheck,
} from "#/server/diagnostics";
import { resendTracking } from "#/server/shipping";

export const Route = createFileRoute("/diagnostics")({
	loader: () => getDiagnostics(),
	component: DiagnosticsPage,
});

const HEALTH: Record<Health, { label: string; tone?: Tone }> = {
	healthy: { label: "Healthy", tone: "success" },
	degraded: { label: "Some orders failing", tone: "warning" },
	failing: { label: "Sync failing", tone: "critical" },
	stale: { label: "No recent sync", tone: "warning" },
	never_synced: { label: "Never synced" },
	not_connected: { label: "Not connected" },
};

const errorMessage = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

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

function DiagnosticsPage() {
	const d = Route.useLoaderData();
	const router = useRouter();

	return (
		<Page
			title="Diagnostics"
			actions={
				<Button variant="outline" size="sm" onClick={() => router.invalidate()}>
					Refresh
				</Button>
			}
		>
			{!d.worker.alive && (
				<Banner tone="critical" title="Order sync isn't running">
					{d.worker.lastStartedAt
						? `No channel has synced since ${formatDateTime(d.worker.lastStartedAt)}. `
						: "No sync has ever been recorded. "}
					Start it on the machine that runs katasync with{" "}
					<code className="rounded bg-white/70 px-1 font-mono">
						pnpm sync --watch
					</code>
					. Until then, new orders don't arrive and stock doesn't move.
				</Banner>
			)}

			<Card flush>
				<ul>
					{d.channels.map((c) => (
						<SummaryRow
							key={c.channel}
							href={`#sync-${c.channel}`}
							name={channelName(c.channel)}
							status={HEALTH[c.health]}
							detail={`Last good sync ${ago(c.lastSuccessAt)}`}
						/>
					))}
					<SummaryRow
						href="#tracking"
						name="Tracking handoff"
						status={
							d.handoffs.length > 0
								? {
										label: `${d.handoffs.length} not sent`,
										tone: "critical",
									}
								: { label: "All sent", tone: "success" }
						}
						detail="Labels whose tracking reached the marketplace"
					/>
					<SummaryRow
						href="#unmapped"
						name="Unmatched SKUs"
						status={
							d.unmapped.some((u) => u.missed > 0)
								? { label: "Stock not taken", tone: "warning" }
								: d.unmapped.length > 0
									? { label: `${d.unmapped.length} in history` }
									: { label: "None", tone: "success" }
						}
						detail="Sold SKUs that match no product"
					/>
					<SummaryRow
						href="#services"
						name="Shipping labels and email"
						status={
							!d.services.shippo.configured || !d.services.email.configured
								? { label: "Not set up", tone: "warning" }
								: d.services.shippo.test
									? { label: "Test labels", tone: "warning" }
									: { label: "Set up", tone: "success" }
						}
						detail="Shippo and Resend"
					/>
				</ul>
			</Card>

			{d.channels.map((c) => (
				<ChannelCard key={c.channel} data={c} />
			))}
			<TrackingCard handoffs={d.handoffs} />
			<UnmappedCard rows={d.unmapped} />
			<ServicesCard services={d.services} />
			<ClaudeCard calls={d.claude} />
		</Page>
	);
}

function SummaryRow({
	href,
	name,
	status,
	detail,
}: {
	href: string;
	name: string;
	status: { label: string; tone?: Tone };
	detail: string;
}) {
	return (
		<li className="border-t first:border-t-0">
			<a
				href={href}
				className="grid grid-cols-[12rem_10rem_minmax(0,1fr)] items-center gap-3 px-4 py-2.5 hover:bg-[#f7f7f7]"
			>
				<span className="font-medium">{name}</span>
				<span>
					<Badge tone={status.tone}>{status.label}</Badge>
				</span>
				<span className="truncate text-muted-foreground">{detail}</span>
			</a>
		</li>
	);
}

type ChannelData = Diagnostics["channels"][number];

function ChannelCard({ data: c }: { data: ChannelData }) {
	const [showRuns, setShowRuns] = useState(false);
	const status = HEALTH[c.health];
	return (
		<div id={`sync-${c.channel}`} className="scroll-mt-16">
			<Card
				title={
					<span className="flex items-center gap-2">
						{channelName(c.channel)} orders
						<Badge tone={status.tone}>{status.label}</Badge>
					</span>
				}
				aside={<CheckButton target={c.channel} />}
			>
				<div className="flex flex-col gap-3">
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
									{c.consecutiveFailures === 1 ? "pass" : "passes"} in a row
								</span>
							</Fact>
						)}
						{c.missing.length > 0 && (
							<Fact label="Missing">
								<span className="font-mono text-xs">
									{c.missing.join(", ")}
								</span>
							</Fact>
						)}
					</Facts>
					{c.latestError && (
						<ErrorBlock title="Latest pass failed with" text={c.latestError} />
					)}
					{c.hint && <HintBlock hint={c.hint} />}
					<CheckResults target={c.channel} />
					{c.issues.length > 0 && (
						<div className="flex flex-col gap-2">
							<p className="font-medium">
								Problems in the latest pass ({formatCount(c.issueCount)})
							</p>
							{c.issues.map((g) => (
								<div
									key={g.message}
									className="rounded-lg border border-warning-border bg-warning-surface p-3"
								>
									<div className="flex items-start justify-between gap-3">
										<span className="font-mono text-xs break-words">
											{g.message}
										</span>
										<span className="shrink-0 text-xs font-medium">
											{formatCount(g.count)}{" "}
											{g.count === 1 ? "order" : "orders"}
										</span>
									</div>
									{g.references.length > 0 && (
										<p className="mt-1 text-xs text-muted-foreground">
											{g.references.join(", ")}
											{g.count > g.references.length &&
												`, +${formatCount(g.count - g.references.length)} more`}
										</p>
									)}
									{g.hint && (
										<p className="mt-2 text-xs">
											<span className="font-medium">{g.hint.title}</span>{" "}
											{g.hint.action}
										</p>
									)}
								</div>
							))}
						</div>
					)}
					{c.runs.length > 0 && (
						<div>
							<button
								type="button"
								onClick={() => setShowRuns((o) => !o)}
								className="flex items-center gap-1 font-medium"
							>
								{showRuns ? (
									<ChevronDown className="size-4" />
								) : (
									<ChevronRight className="size-4" />
								)}
								Recent passes ({c.runs.length})
							</button>
							{showRuns && <RunTable runs={c.runs} />}
						</div>
					)}
				</div>
			</Card>
		</div>
	);
}

function RunTable({ runs }: { runs: ChannelData["runs"] }) {
	return (
		<table className="mt-2 w-full">
			<thead>
				<tr className="text-left text-xs text-muted-foreground">
					<th className="py-1 pr-3 font-medium">Started</th>
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

function TrackingCard({ handoffs }: { handoffs: Diagnostics["handoffs"] }) {
	const router = useRouter();
	const [busy, setBusy] = useState<number | null>(null);

	async function retry(shipmentId: number) {
		setBusy(shipmentId);
		try {
			const r = await resendTracking({ data: { id: shipmentId } });
			if (r.sent) toast.success(r.message);
			else toast.error(r.message);
			await router.invalidate();
		} catch (err) {
			toast.error(errorMessage(err));
		} finally {
			setBusy(null);
		}
	}

	return (
		<div id="tracking" className="scroll-mt-16">
			<Card title="Tracking handoff" flush>
				{handoffs.length === 0 ? (
					<p className="px-4 pb-4 text-muted-foreground">
						Every label's tracking reached its marketplace.
					</p>
				) : (
					<ul>
						{handoffs.map((h) => (
							<li
								key={h.shipmentId}
								className="flex items-start gap-3 border-t px-4 py-3"
							>
								<div className="min-w-0 flex-1">
									<Link
										to="/orders/$id"
										params={{ id: String(h.orderId) }}
										className="font-medium hover:underline"
									>
										{h.orderName}
									</Link>{" "}
									<span className="text-muted-foreground">
										on {channelName(h.channel)}, label{" "}
										{formatDateTime(h.createdAt)}
										{h.trackingNumber && ` · ${h.trackingNumber}`}
									</span>
									<p className="mt-1 font-mono text-xs break-words text-critical-text">
										{h.error}
									</p>
								</div>
								<Button
									size="sm"
									variant="outline"
									disabled={busy !== null}
									onClick={() => retry(h.shipmentId)}
								>
									{busy === h.shipmentId ? "Sending…" : "Retry"}
								</Button>
							</li>
						))}
					</ul>
				)}
			</Card>
		</div>
	);
}

function UnmappedCard({ rows }: { rows: Diagnostics["unmapped"] }) {
	return (
		<div id="unmapped" className="scroll-mt-16">
			<Card
				title="Unmatched SKUs"
				flush
				aside={
					rows.length > 0 && (
						<Link to="/listings" className="text-link hover:underline">
							Match on Listings
						</Link>
					)
				}
			>
				{rows.length === 0 ? (
					<p className="px-4 pb-4 text-muted-foreground">
						Every SKU sold matches a product.
					</p>
				) : (
					<>
						<p className="px-4 pb-2 text-muted-foreground">
							Matching a listing to its product makes these orders take their
							stock. "Stock not taken" counts orders that should have.
						</p>
						<table className="w-full">
							<thead>
								<tr className="border-y bg-[#f7f7f7] text-left text-xs text-muted-foreground">
									<th className="px-4 py-2 font-medium">SKU</th>
									<th className="px-3 py-2 font-medium">Store</th>
									<th className="px-3 py-2 text-right font-medium">Orders</th>
									<th className="px-3 py-2 text-right font-medium">
										Stock not taken
									</th>
									<th className="px-4 py-2 text-right font-medium">
										Last sold
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((r) => (
									<tr key={`${r.store}:${r.sku}`} className="border-t">
										<td className="px-4 py-2 font-mono text-xs">{r.sku}</td>
										<td className="px-3 py-2">{r.store}</td>
										<td className="px-3 py-2 text-right tabular-nums">
											{formatCount(r.orders)}
										</td>
										<td className="px-3 py-2 text-right tabular-nums">
											{r.missed > 0 ? (
												<Badge tone="warning">{formatCount(r.missed)}</Badge>
											) : (
												<span className="text-muted-foreground">0</span>
											)}
										</td>
										<td className="px-4 py-2 text-right whitespace-nowrap text-muted-foreground">
											{ago(r.lastPlacedAt)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</>
				)}
			</Card>
		</div>
	);
}

function ServicesCard({ services }: { services: Diagnostics["services"] }) {
	return (
		<div id="services" className="scroll-mt-16">
			<Card title="Shipping labels and email" flush>
				<ServiceRow
					name="Shippo"
					target="shippo"
					status={
						!services.shippo.configured
							? "SHIPPO_API_KEY isn't set, so labels can't be bought."
							: services.shippo.test
								? "Test key: labels are samples that can't ship."
								: "Live key."
					}
				/>
				<ServiceRow
					name="PO email (Resend)"
					target="email"
					status={
						services.email.configured
							? `Sends as ${services.email.from}`
							: "RESEND_API_KEY and PO_EMAIL_FROM aren't set, so POs can't be emailed."
					}
				/>
			</Card>
		</div>
	);
}

function ServiceRow({
	name,
	target,
	status,
}: {
	name: string;
	target: CheckTarget;
	status: string;
}) {
	return (
		<div className="flex flex-col gap-2 border-t px-4 py-3">
			<div className="flex items-center justify-between gap-3">
				<div>
					<p className="font-medium">{name}</p>
					<p className="text-muted-foreground">{status}</p>
				</div>
				<CheckButton target={target} />
			</div>
			<CheckResults target={target} />
		</div>
	);
}

// Live check results, kept per target outside React so the button in a
// card's header and the results in its body share one.
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
		try {
			results.set(target, await runConnectionCheck({ data: { target } }));
			for (const listener of listeners) listener();
		} catch (err) {
			toast.error(`The check couldn't run: ${errorMessage(err)}`);
		} finally {
			setRunning(false);
		}
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
				Connection check, {new Date(result.ranAt).toLocaleTimeString()}
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
				<button type="button" onClick={() => copy(text)} title="Copy">
					<Copy className="size-3.5" />
				</button>
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

// What Claude changed through /mcp, newest first. Arguments are what it
// asked for; the result is what katasync answered.
function ClaudeCard({ calls }: { calls: Diagnostics["claude"] }) {
	const [open, setOpen] = useState<number | null>(null);
	return (
		<div id="claude" className="scroll-mt-16">
			<Card title="Changes made by Claude" flush>
				{calls.length === 0 ? (
					<p className="px-4 pb-4 text-muted-foreground">
						None yet. Changes made through Claude (MCP) are listed here.
					</p>
				) : (
					<ul>
						{calls.map((c) => (
							<li key={c.id} className="border-t">
								<button
									type="button"
									onClick={() => setOpen(open === c.id ? null : c.id)}
									className="grid w-full grid-cols-[9rem_10rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-left hover:bg-[#f7f7f7]"
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
											With the token {c.tokenName}
										</p>
										<pre className="max-h-48 overflow-auto rounded-lg bg-[#f7f7f7] p-2 font-mono text-xs break-words whitespace-pre-wrap">
											{JSON.stringify(JSON.parse(c.arguments), null, 1)}
										</pre>
										<pre
											className={cn(
												"max-h-48 overflow-auto rounded-lg p-2 font-mono text-xs break-words whitespace-pre-wrap",
												c.ok
													? "bg-[#f7f7f7]"
													: "bg-critical-surface text-critical-text",
											)}
										>
											{c.result}
										</pre>
									</div>
								)}
							</li>
						))}
					</ul>
				)}
			</Card>
		</div>
	);
}
