import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { ReturnedLine } from "#/orders/return-rates";
import { returnReasons } from "#/orders/return-reasons";

// One product on Returns › Insights: its reasons as chips, a summary and a
// badge the list chooses, and (opened) each order that came back, with what
// says so and what the buyer wrote.

export const day = (d: Date) =>
	d.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});

export const ordersCount = (n: number) =>
	`${formatCount(n)} ${n === 1 ? "order" : "orders"}`;

export function ReturnRow({
	product: p,
	lines,
	summary,
	badge,
}: {
	product: {
		sku: string;
		name: string;
		variantName: string | null;
		imageUrl: string | null;
	};
	lines: ReturnedLine[];
	summary: ReactNode;
	badge?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const reasons = returnReasons(lines.flatMap((l) => l.reasons).join("; "));
	return (
		<div className="border-t">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface"
			>
				<ChevronRight
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-90",
					)}
				/>
				<ProductImage src={p.imageUrl} className="size-9" />
				<div className="min-w-0 flex-1">
					<ProductName name={p.name} variantName={p.variantName} />
					<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
						<span>{p.sku}</span>
						{reasons.map((reason) => (
							<ReasonChip key={reason.chip} reason={reason} />
						))}
					</div>
				</div>
				<div className="shrink-0 text-right tabular-nums">{summary}</div>
				<div className="flex w-28 shrink-0 justify-end">{badge}</div>
			</button>
			{open && (
				<div className="bg-subtle px-4 py-2 pl-14">
					{lines.map((l, i) => (
						<div
							// An order can sell the same product on two lines.
							// biome-ignore lint/suspicious/noArrayIndexKey: lines don't reorder
							key={i}
							className="flex flex-wrap items-center gap-2 py-1"
						>
							<Link
								to="/orders/$id"
								params={{ id: String(l.orderId) }}
								className="font-medium text-link hover:underline"
							>
								{l.orderName}
							</Link>
							<ChannelBadge
								channel={l.channel}
								salesChannel={l.salesChannel}
								compact
							/>
							<span className="text-muted-foreground">
								{day(new Date(l.placedAt))}
							</span>
							<span className="tabular-nums">
								{formatCount(l.returned)} of {formatCount(l.sold)}
							</span>
							<Evidence line={l} />
							{returnReasons(l.reasons.join("; ")).map((reason) => (
								<ReasonChip key={reason.chip} reason={reason} />
							))}
							{l.notes.map((note) => (
								<q key={note} className="basis-full text-muted-foreground">
									{note}
								</q>
							))}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// What says it came back, strongest first.
function Evidence({ line: l }: { line: ReturnedLine }) {
	return (
		<>
			{l.received > 0 && (
				<Badge tone="success">Received {formatCount(l.received)}</Badge>
			)}
			{l.requested > 0 && (
				<Badge tone="info">Requested {formatCount(l.requested)}</Badge>
			)}
			{l.refundedInFull && (
				<Tip content="The order was refunded in full">
					<span>
						<Badge tone="warning">Refunded</Badge>
					</span>
				</Tip>
			)}
		</>
	);
}

// A reason in a word or two; hovering says it in full.
function ReasonChip({ reason }: { reason: { chip: string; text: string } }) {
	const chip = <Badge>{reason.chip}</Badge>;
	return reason.text === reason.chip ? (
		chip
	) : (
		<Tip content={reason.text}>
			<span>{chip}</span>
		</Tip>
	);
}
