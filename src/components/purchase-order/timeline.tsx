import type { ReactNode } from "react";
import { Button } from "#/components/ui/button";
import { formatCount, formatDay, formatMoney, formatTime } from "#/lib/format";
import { describeTerms, lineCents } from "#/purchasing/discount";
import {
	type PurchaseOrderDetail,
	undoPurchaseReceipt,
} from "#/server/purchasing";
import { EmailEntry } from "./email-entry";
import { poData } from "./po-data";
import { useAction } from "./use-action";

type Amendment = PurchaseOrderDetail["amendments"][number];

function amendmentText(a: Amendment, name: string) {
	const was = formatCount(a.quantityBefore ?? 0);
	const now = formatCount(a.quantityAfter ?? 0);
	switch (a.kind) {
		case "added":
			return `Added ${now} × ${name} after sending`;
		case "removed":
			return `Took ${name} off`;
		case "quantity":
			return a.quantityAfter === 0
				? `None of ${name} coming, was ${was}`
				: `${name} changed from ${was} to ${now}`;
		case "cost":
			return `${name} cost changed from ${formatMoney(a.unitCostBefore)} to ${formatMoney(a.unitCostAfter)}`;
	}
}

// Marks a timeline entry as a change kept here, never sent.
function NotSent({ children }: { children: ReactNode }) {
	return <span className="text-warning-text"> · {children}</span>;
}

type TimelineEvent = {
	key: string;
	at: Date;
	body: ReactNode;
	undo?: PurchaseOrderDetail["receipts"][number];
};

// Everything that happened to the PO, newest first and grouped by day, like
// the timeline under a Shopify order. Receipts can be undone from here.
export function Timeline({ detail: d }: { detail: PurchaseOrderDetail }) {
	const { save } = useAction();
	const po = d.order;
	const lines = new Map(d.lines.map((l) => [l.id, l]));
	const events: TimelineEvent[] = [
		{ key: "created", at: new Date(po.createdAt), body: "PO created" },
	];
	if (po.sentAt)
		events.push({
			key: "sent",
			at: new Date(po.sentAt),
			body: po.sentTo ? `Sent to ${po.sentTo}` : "Marked as ordered",
		});
	for (const r of d.receipts) {
		const line = lines.get(r.lineId);
		events.push({
			key: `r${r.id}`,
			at: new Date(r.createdAt),
			undo: r,
			body: (
				<>
					Received{" "}
					<span className="font-semibold tabular-nums">
						{formatCount(r.quantity)}
					</span>
					{line && line.packSize !== 1 && ` ${line.unit}`} × {line?.name ?? "?"}
					{line?.variantName && (
						<span className="text-muted-foreground"> {line.variantName}</span>
					)}
					{r.quantityBefore !== null && r.quantityAfter !== null && (
						<NotSent>
							{r.quantityBefore === 0
								? "not on the PO, added"
								: r.quantityAfter > r.quantityBefore
									? `more than the ${formatCount(r.quantityBefore)} expected, kept`
									: `that's all they sent, of ${formatCount(r.quantityBefore)}`}
						</NotSent>
					)}
				</>
			),
		});
	}
	for (const a of d.amendments) {
		const name = a.variantName ? `${a.name} (${a.variantName})` : a.name;
		events.push({
			key: `a${a.id}`,
			at: new Date(a.createdAt),
			body: (
				<>
					{amendmentText(a, name)}
					<NotSent>supplier not told</NotSent>
				</>
			),
		});
	}
	// Discounts changed after sending, and ones that came in a delivery.
	if (po.sentAt) {
		const sentAt = new Date(po.sentAt);
		for (const x of d.discountHistory) {
			const line = lines.get(x.lineId);
			const name = line
				? line.variantName
					? `${line.name} (${line.variantName})`
					: line.name
				: "?";
			const terms = describeTerms(x);
			if (!x.sent && new Date(x.createdAt) > sentAt)
				events.push({
					key: `d${x.id}`,
					at: new Date(x.createdAt),
					body: (
						<>
							{terms} on {name}
							<NotSent>
								{x.receiptId !== null ? "in the delivery" : "supplier not told"}
							</NotSent>
						</>
					),
				});
			if (x.removedAt)
				events.push({
					key: `dr${x.id}`,
					at: new Date(x.removedAt),
					body: (
						<>
							Took {terms} off {name}
							<NotSent>supplier not told</NotSent>
						</>
					),
				});
		}
	}
	// What the PO comes to now, in cents, to set each invoice against.
	const poCents = d.lines.reduce(
		(n, l) => n + (lineCents(l, l.discounts) ?? 0),
		0,
	);
	for (const inv of d.invoices) {
		const over = Math.round(inv.total * 100) - poCents;
		// Midday, so the date doesn't slip a day in any US timezone.
		const day = (s: string) => formatDay(new Date(`${s}T12:00:00`));
		events.push({
			key: `i${inv.id}`,
			at: new Date(inv.createdAt),
			body: (
				<>
					Invoice <span className="font-semibold">{inv.number}</span> for{" "}
					<span className="tabular-nums">{formatMoney(inv.total)}</span>, dated{" "}
					{day(inv.invoicedOn)}
					{inv.dueOn && <>, due {day(inv.dueOn)}</>}
					{over !== 0 && (
						<span className="text-warning-text">
							{" "}
							· {formatMoney(Math.abs(over) / 100)} {over > 0 ? "more" : "less"}{" "}
							than the PO
						</span>
					)}
				</>
			),
		});
	}
	for (const e of d.emails)
		events.push({
			key: `e${e.id}`,
			at: new Date(e.receivedAt),
			body: <EmailEntry email={e} poId={po.id} />,
		});
	if (po.closedAt)
		events.push({
			key: "closed",
			at: new Date(po.closedAt),
			body: po.status === "cancelled" ? "PO cancelled" : "PO closed",
		});
	events.sort((a, b) => b.at.getTime() - a.at.getTime());

	const days: { day: string; events: TimelineEvent[] }[] = [];
	for (const e of events) {
		const day = formatDay(e.at);
		if (days.at(-1)?.day !== day) days.push({ day, events: [] });
		days.at(-1)?.events.push(e);
	}

	return (
		<section>
			<h2 className="px-1 pb-2 text-sm font-semibold">Timeline</h2>
			<ol className="relative ml-3 border-l-2 border-border pb-1">
				{days.map((g) => (
					<li key={g.day}>
						<div className="py-2 pl-6 text-xs font-medium text-muted-foreground">
							{g.day}
						</div>
						<ul>
							{g.events.map((e) => {
								const receipt = e.undo;
								const line = receipt && lines.get(receipt.lineId);
								return (
									<li
										key={e.key}
										className="relative flex min-h-9 items-center gap-3 py-1 pl-6"
									>
										<span className="absolute top-1/2 -left-[7px] size-3 -translate-y-1/2 rounded-full border-2 border-background bg-muted-foreground/60" />
										<span className="min-w-0 flex-1">{e.body}</span>
										<span className="shrink-0 text-muted-foreground tabular-nums">
											{formatTime(e.at)}
										</span>
										{/* Always the same width, so the times line up. */}
										<span className="w-16 shrink-0 text-right">
											{receipt && (
												<Button
													size="sm"
													variant="ghost"
													onClick={() =>
														save({
															label: "Taking the receipt back",
															// Off the timeline too, so it can't be undone twice.
															patch: poData.patch(po.id, (data) => ({
																...data,
																receipts: data.receipts.filter(
																	(x) => x.id !== receipt.id,
																),
																lines: data.lines.map((l) =>
																	l.id !== receipt.lineId
																		? l
																		: {
																				...l,
																				received: l.received - receipt.quantity,
																				quantity:
																					receipt.quantityBefore !== null &&
																					l.quantity === receipt.quantityAfter
																						? receipt.quantityBefore
																						: l.quantity,
																			},
																),
															})),
															send: () =>
																undoPurchaseReceipt({
																	data: { id: receipt.id },
																}),
															success: () =>
																`Took ${formatCount(receipt.quantity * (line?.packSize ?? 1))} back off the shelf`,
														})
													}
												>
													Undo
												</Button>
											)}
										</span>
									</li>
								);
							})}
						</ul>
					</li>
				))}
			</ol>
		</section>
	);
}
