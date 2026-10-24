import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Card } from "#/components/page";
import { Tip } from "#/components/ui/tooltip";
import { channelName, formatOrderDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { OrderDetail } from "#/server/orders";

// What katasync holds for the order and when it last heard about it, for
// when the order isn't where it should be: its IDs on each channel, the
// channel's own statuses, and each marketplace's charges as last asked.
export function DetailsCard({ detail: d }: { detail: OrderDetail }) {
	const o = d.order;
	// The marketplace's own ID, when another store relays the order (an
	// order's own channel names it the same, so that's left out).
	const marketplace = /^([a-z]+):(.+)$/.exec(o.marketplaceOrderId ?? "");
	const relayed = marketplace?.[1] === o.channel ? null : marketplace;
	const asked = [
		...new Set([
			...d.reports.map((r) => r.billedBy),
			...d.checks.map((c) => c.billedBy),
		]),
	].map((billedBy) => ({
		billedBy,
		report: d.reports.find((r) => r.billedBy === billedBy),
		check: d.checks.find((c) => c.billedBy === billedBy),
	}));
	return (
		<Card title="Details">
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
				<Field label={`${channelName(o.channel)} ID`}>
					<Copyable text={o.externalId.split("/").pop() ?? o.externalId} />
				</Field>
				{relayed && (
					<Field label={`${channelName(relayed[1])} ID`}>
						<Copyable text={relayed[2]} />
					</Field>
				)}
				<Field label="Store">{o.store}</Field>
				<Field label="Fulfillment">{words(o.fulfillmentStatus)}</Field>
				{o.financialStatus && (
					<Field label="Payment">{words(o.financialStatus)}</Field>
				)}
				{o.taxRemittedBy && (
					<Field label="Sales tax">
						{o.taxRemittedBy === "marketplace"
							? "Paid by the marketplace"
							: "Ours to pay"}
					</Field>
				)}
				<Field label="Synced">{formatOrderDate(o.syncedAt)}</Field>
				<Field label="Changed there">
					{formatOrderDate(o.sourceUpdatedAt)}
				</Field>
				{asked.map((a) => (
					<Field key={a.billedBy} label={`${channelName(a.billedBy)} charges`}>
						{a.check?.error ? (
							<Tip content={a.check.error}>
								<span className="cursor-help text-critical-text underline decoration-dotted underline-offset-4">
									Failed {formatOrderDate(a.check.checkedAt)}
								</span>
							</Tip>
						) : a.report ? (
							<span className={cn(!a.report.settled && "italic")}>
								{a.report.settled ? "Settled" : "Reported"}{" "}
								{formatOrderDate(a.report.fetchedAt)}
							</span>
						) : (
							<span className="italic">
								Nothing yet
								{a.check && `, asked ${formatOrderDate(a.check.checkedAt)}`}
							</span>
						)}
					</Field>
				))}
			</dl>
		</Card>
	);
}

// UNFULFILLED → Unfulfilled, PARTIALLY_PAID → Partially paid.
const words = (s: string) =>
	s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ");

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-right">{children}</dd>
		</>
	);
}

// An ID that copies on a click; the icon turns to a check to say it did.
function Copyable({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={() =>
				navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				})
			}
			className="group inline-flex max-w-full items-center gap-1 font-mono text-xs hover:text-link"
		>
			<span className="truncate">{text}</span>
			{copied ? (
				<Check className="size-3 shrink-0 text-success-icon" />
			) : (
				<Copy className="size-3 shrink-0 opacity-0 group-hover:opacity-100" />
			)}
		</button>
	);
}
