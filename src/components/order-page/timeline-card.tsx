import type { ReactNode } from "react";
import { Card } from "#/components/page";
import {
	channelName,
	formatCount,
	formatDay,
	formatMoney,
	formatTime,
} from "#/lib/format";
import { cn } from "#/lib/utils";
import { returnReason } from "#/orders/return-reasons";
import type { OrderDetail } from "#/server/orders";

type Event = {
	key: string;
	at: Date;
	body: ReactNode;
	// Colors the dot: something went wrong, or money or stock came back.
	tone?: "critical" | "success" | "info";
};

const DOT: Record<NonNullable<Event["tone"]> | "none", string> = {
	none: "bg-muted-foreground/60",
	critical: "bg-critical-icon",
	success: "bg-success-icon",
	info: "bg-info-icon",
};

// Everything that happened to the order, newest first and grouped by day:
// from the sale through labels, tracking, the marketplace's charges,
// returns, and mail. What katasync knows, so it's where to look when the
// order isn't where it should be.
export function TimelineCard({ detail: d }: { detail: OrderDetail }) {
	const o = d.order;
	const channel = o.salesChannel ?? channelName(o.channel);
	const lines = new Map(d.lines.map((l) => [l.id, l]));
	const events: Event[] = [
		{ key: "placed", at: new Date(o.placedAt), body: `Placed on ${channel}` },
	];
	if (o.cancelledAt)
		events.push({
			key: "cancelled",
			at: new Date(o.cancelledAt),
			body: "Cancelled",
			tone: "critical",
		});
	if (o.invoicePrintedAt)
		events.push({
			key: "printed",
			at: new Date(o.invoicePrintedAt),
			body: "Invoice printed",
		});
	for (const s of d.sends) {
		for (const b of s.boxes) {
			events.push({
				key: `b${b.id}`,
				at: new Date(b.createdAt),
				body: (
					<>
						{b.test ? "Test label" : "Label"} bought: {b.serviceName}
						{b.provider !== "tiktok" && (
							<span className="tabular-nums">, {formatMoney(b.cost)}</span>
						)}
						{b.trackingNumber && (
							<span className="text-muted-foreground">
								{" "}
								· {b.trackingNumber}
							</span>
						)}
					</>
				),
			});
			if (b.voidedAt)
				events.push({
					key: `v${b.id}`,
					at: new Date(b.voidedAt),
					body: `${b.serviceName} label voided`,
				});
		}
		if (s.channelSentAt)
			events.push({
				key: `t${s.id}`,
				at: new Date(s.channelSentAt),
				body: `Tracking sent to ${channelName(o.channel)}`,
				tone: "success",
			});
	}
	for (const r of d.reports)
		events.push({
			key: `c${r.billedBy}`,
			at: new Date(r.fetchedAt),
			body: `${channelName(r.billedBy)} reported its charges${r.settled ? ", settled" : ""}`,
		});
	for (const r of d.returnRequests)
		events.push({
			key: `rr${r.id}`,
			at: new Date(r.requestedAt),
			body: `${r.kind === "refund" ? "Refund asked" : "Return opened"} on ${channelName(r.billedBy)}${r.reason ? `: ${returnReason(r.reason)}` : ""}`,
			tone: "info",
		});
	for (const r of d.returnsReceived) {
		const l = lines.get(r.lineId);
		events.push({
			key: `rx${r.id}`,
			at: new Date(r.createdAt),
			body: `Received ${formatCount(r.quantity)} × ${l?.sku ?? l?.title ?? "an item"} back${r.refurb ? `, as ${r.refurb.sku}` : r.restocked ? ", on the shelf" : r.preCutover ? "" : ", written off"}`,
			tone: "success",
		});
	}
	if (o.noReturnAt)
		events.push({
			key: "noreturn",
			at: new Date(o.noReturnAt),
			body: "Marked nothing coming back",
		});
	for (const e of d.mail.emails)
		events.push({
			key: `e${e.id}`,
			at: new Date(e.receivedAt),
			body: (
				<>
					<span className="text-muted-foreground">Email: </span>
					{e.subject}
				</>
			),
			tone: e.critical ? "critical" : undefined,
		});
	for (const t of d.mail.threads)
		for (const m of t.messages)
			events.push({
				key: `m${m.id}`,
				at: new Date(m.at),
				body: m.fromBuyer
					? `${t.buyerName ?? "The buyer"} wrote`
					: m.status === "failed"
						? "Our reply didn't send"
						: "We replied",
				tone: m.status === "failed" ? "critical" : undefined,
			});
	events.sort((a, b) => b.at.getTime() - a.at.getTime());

	const days: { day: string; events: Event[] }[] = [];
	for (const e of events) {
		const day = formatDay(e.at);
		if (days.at(-1)?.day !== day) days.push({ day, events: [] });
		days.at(-1)?.events.push(e);
	}

	return (
		<Card title="Timeline">
			<ol className="relative ml-1.5 border-l-2 border-border">
				{days.map((g) => (
					<li key={g.day}>
						<div className="py-1.5 pl-5 text-xs font-medium text-muted-foreground first:pt-0">
							{g.day}
						</div>
						<ul>
							{g.events.map((e) => (
								<li
									key={e.key}
									className="relative flex items-baseline gap-3 py-1 pl-5"
								>
									<span
										className={cn(
											"absolute top-2.5 -left-[7px] size-3 -translate-y-1/2 rounded-full border-2 border-card",
											DOT[e.tone ?? "none"],
										)}
									/>
									<span className="min-w-0 flex-1">{e.body}</span>
									<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
										{formatTime(e.at)}
									</span>
								</li>
							))}
						</ul>
					</li>
				))}
			</ol>
		</Card>
	);
}
