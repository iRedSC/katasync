import { Badge, type Tone } from "#/components/page";
import { PanelHeader, SidePanel } from "#/components/panel";
import type { CheckTarget } from "#/diagnostics/checks";
import { channelName, formatCount, formatDateTime } from "#/lib/format";
import type { Diagnostics } from "#/server/diagnostics";
import { ErrorBlock, Fact, Facts, HintBlock } from "./blocks";
import { CheckButton, CheckResults } from "./connection-check";
import {
	ago,
	type ChannelData,
	emailStatus,
	HEALTH,
	shippoStatus,
} from "./status";

// Details of one connection, from the side.

export function Sheet({
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
