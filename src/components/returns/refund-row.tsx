import { CircleCheck, ExternalLink, Undo2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge, type Tone } from "#/components/page";
import { ProductImage } from "#/components/product";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatDate, formatMoney } from "#/lib/format";
import type { useRowLink } from "#/lib/row-link";
import { cn } from "#/lib/utils";
import type { RefundRow as Row, TriagedItem } from "#/orders/refund-queue";
import type { RefundDecisionKind, RefundStep } from "#/orders/refund-step";
import { returnReason } from "#/orders/return-reasons";
import { ICON_BUTTON } from "./return-row";

// One order on the Refunds view: what came back and how it was checked in,
// what the buyer said, the money, and the decision about it.

export type Choice = {
	decision: RefundDecisionKind;
	amount: number | null;
	note: string | null;
};

const OUTCOME: Record<TriagedItem["outcome"], { label: string; tone?: Tone }> =
	{
		restocked: { label: "Restocked", tone: "success" },
		refurbished: { label: "Refurbished", tone: "success" },
		bench: { label: "In repair", tone: "info" },
		written_off: { label: "Written off", tone: "critical" },
	};

const DONE: Record<Extract<RefundStep, { kind: "done" }>["how"], string> = {
	seen: "Refunded",
	already: "Already refunded",
	confirmed: "Refunded",
	refused: "No refund",
	resolved: "Resolved",
};

const LINK =
	"inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-link hover:bg-surface-strong";

export function RefundRow({
	row: r,
	step,
	onDecide,
	onSettle,
	onUndo,
	link,
}: {
	row: Row;
	step: RefundStep;
	onDecide: (choice: Choice) => void;
	onSettle: () => void;
	onUndo: () => void;
	link: ReturnType<typeof useRowLink>["link"];
}) {
	return (
		<tr
			{...link({ to: "/orders/$id", params: { id: String(r.orderId) } })}
			className={cn(
				"cursor-pointer border-t align-top first:border-t-0 hover:bg-subtle",
				step.kind === "done" && "text-muted-foreground",
			)}
		>
			<td className="px-4 py-2.5">
				<div className="flex items-center gap-1.5 font-semibold">
					{r.name}
					<ChannelBadge channel={r.channel} salesChannel={r.salesChannel} />
				</div>
				<div className="text-xs text-muted-foreground">
					{r.customerName ?? "No name"}
				</div>
			</td>
			<td className="w-2/5 max-w-0 px-4 py-2">
				<ul className="flex flex-col gap-1.5">
					{r.items.map((i) => (
						<li key={i.key} className="flex min-w-0 items-start gap-2">
							<ProductImage src={i.imageUrl} className="size-8" />
							<div className="min-w-0 flex-1">
								<div className="flex min-w-0 items-center gap-1.5">
									<span className="shrink-0 font-semibold tabular-nums">
										{formatCount(i.quantity)} ×
									</span>
									<span className="truncate">{i.sku ?? i.title}</span>
									<Badge tone={OUTCOME[i.outcome].tone}>
										{OUTCOME[i.outcome].label}
										{i.ref && ` ${i.ref}`}
									</Badge>
								</div>
								{i.note && (
									<div className="truncate text-xs text-warning-text">
										“{i.note}”
									</div>
								)}
								<div className="text-xs text-muted-foreground">
									Checked in {formatDate(i.at)}
								</div>
							</div>
						</li>
					))}
				</ul>
			</td>
			<td className="hidden max-w-48 px-4 py-2.5 lg:table-cell">
				{r.request?.reason && (
					<div className="truncate">{returnReason(r.request.reason)}</div>
				)}
				{r.request?.note && (
					<Tip content={r.request.note}>
						<div className="truncate text-xs text-muted-foreground">
							“{r.request.note}”
						</div>
					</Tip>
				)}
			</td>
			<td className="px-4 py-2.5 tabular-nums">
				{r.refundedNow > 0 ? (
					<div className="flex items-center gap-1 font-medium text-success-text">
						<CircleCheck className="size-4" />
						{formatMoney(r.refundedNow)} refunded
					</div>
				) : (
					<div className="font-medium">Nothing refunded</div>
				)}
				<div className="text-xs text-muted-foreground">
					Sold for {formatMoney(r.itemValue)}
				</div>
			</td>
			{/* Deciding doesn't open the order. */}
			<td
				className="w-0 py-1.5 pr-2"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<Decide
					row={r}
					step={step}
					onDecide={onDecide}
					onSettle={onSettle}
					onUndo={onUndo}
				/>
			</td>
		</tr>
	);
}

function Decide({
	row: r,
	step,
	onDecide,
	onSettle,
	onUndo,
}: {
	row: Row;
	step: RefundStep;
	onDecide: (choice: Choice) => void;
	onSettle: () => void;
	onUndo: () => void;
}) {
	const [asking, setAsking] = useState<"partial" | "other" | null>(null);
	const [text, setText] = useState("");
	const page = r.page;
	const out = page && (
		<a href={page.url} target="_blank" rel="noreferrer" className={LINK}>
			Refund on {page.name}
			<ExternalLink className="size-3.5" />
		</a>
	);
	const undo = (
		<Tip content="Undo this decision">
			<button
				type="button"
				aria-label="Undo this decision"
				onClick={onUndo}
				className={ICON_BUTTON}
			>
				<Undo2 className="size-4" />
			</button>
		</Tip>
	);

	switch (step.kind) {
		case "decide": {
			if (asking) {
				const amount = Number(text);
				const ok =
					asking === "partial"
						? Number.isFinite(amount) && amount > 0
						: text.trim() !== "";
				const submit = (e: FormEvent) => {
					e.preventDefault();
					if (!ok) return;
					onDecide(
						asking === "partial"
							? { decision: "partial", amount, note: null }
							: { decision: "other", amount: null, note: text.trim() },
					);
					setAsking(null);
					setText("");
				};
				return (
					<form onSubmit={submit} className="flex items-center gap-1">
						<input
							// biome-ignore lint/a11y/noAutofocus: opened to type the amount or what's next
							autoFocus
							value={text}
							onChange={(e) => setText(e.target.value)}
							onKeyDown={(e) => e.key === "Escape" && setAsking(null)}
							inputMode={asking === "partial" ? "decimal" : undefined}
							placeholder={
								asking === "partial" ? "Amount" : "What needs doing?"
							}
							className={cn(
								"h-7 rounded-lg border border-input bg-white px-2 text-sm outline-none focus:border-ring",
								asking === "partial" ? "w-24 tabular-nums" : "w-56",
							)}
						/>
						<Button size="sm" type="submit" disabled={!ok}>
							{asking === "partial" ? "Refund" : "Flag"}
						</Button>
						<Button
							size="sm"
							type="button"
							variant="ghost"
							onClick={() => setAsking(null)}
						>
							Cancel
						</Button>
					</form>
				);
			}
			return (
				<div className="flex items-center justify-end gap-1">
					<Button
						size="sm"
						onClick={() =>
							onDecide({ decision: "full", amount: null, note: null })
						}
					>
						Full refund
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => setAsking("partial")}
					>
						Partial
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() =>
							onDecide({ decision: "none", amount: null, note: null })
						}
					>
						No refund
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => setAsking("other")}
					>
						Something else
					</Button>
				</div>
			);
		}
		case "send":
			return (
				<div className="flex items-center justify-end gap-1 whitespace-nowrap">
					<span className="text-xs text-muted-foreground">
						{step.decision.decision === "partial" && step.decision.amount
							? `${formatMoney(step.decision.amount)} decided`
							: "Full refund decided"}
					</span>
					{out}
					<Button size="sm" variant="outline" onClick={onSettle}>
						It's refunded
					</Button>
					{undo}
				</div>
			);
		case "flagged":
			return (
				<div className="flex items-center justify-end gap-1">
					<span className="max-w-56 truncate text-sm text-warning-text">
						{step.decision.note}
					</span>
					<Button size="sm" variant="outline" onClick={onSettle}>
						Resolved
					</Button>
					{undo}
				</div>
			);
		case "done":
			return (
				<div className="flex items-center justify-end gap-1 whitespace-nowrap">
					<Badge tone={step.how === "refused" ? undefined : "success"}>
						{DONE[step.how]}
					</Badge>
					{undo}
				</div>
			);
	}
}
