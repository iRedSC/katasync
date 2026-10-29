import {
	Ban,
	CircleCheck,
	CircleHelp,
	Clock,
	PackageCheck,
	Truck,
	Undo2,
} from "lucide-react";
import { PackageWhere } from "#/components/package-status";
import { formatDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import type {
	BackOutcome,
	Item,
	Money,
	Next,
	Refund,
} from "#/orders/return-situation";
import type { ReturnOrder } from "#/orders/returns-due";

// The Returns tab's two questions, a cell each: where the item is, and
// whether the buyer got their money. Color says whether it's settled
// (green), ours to act on (amber), or someone else's turn (blue or gray).

type GroupKey = Exclude<Next["kind"], "done">;

// One group per next step, most urgent first. label is what the status
// search chip says.
export const GROUPS: Record<
	GroupKey,
	{ heading: string; label: string; dot: string }
> = {
	check_in: {
		heading: "Arrived: check it in",
		label: "arrived",
		dot: "bg-amber-500",
	},
	answer: {
		heading: "Waiting on our answer",
		label: "answer",
		dot: "bg-amber-500",
	},
	refund: {
		heading: "Back, not refunded",
		label: "not refunded",
		dot: "bg-amber-500",
	},
	decide: {
		heading: "Refunded, not back",
		label: "not back",
		dot: "bg-amber-500",
	},
	in_transit: {
		heading: "On its way back",
		label: "on its way",
		dot: "bg-sky-500",
	},
	with_buyer: {
		heading: "Buyer hasn't shipped",
		label: "not shipped",
		dot: "bg-neutral-400",
	},
	close: {
		heading: "Done here, still open on the marketplace",
		label: "still open",
		dot: "bg-neutral-300",
	},
};

const money = (m: Money) =>
	new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: m.currency,
	}).format(m.amount);

const OUTCOME: Record<BackOutcome, string> = {
	restocked: "Restocked",
	refurbished: "Refurbished",
	written_off: "Written off",
	counted: "Counted at cutover",
};

function Line({
	icon: Icon,
	tone,
	title,
	detail,
}: {
	icon: typeof Truck;
	tone: "settled" | "ours" | "theirs" | "quiet";
	title: React.ReactNode;
	detail?: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 items-start gap-1.5">
			<Icon
				className={cn(
					"mt-0.5 size-4 shrink-0",
					tone === "settled" && "text-success-text",
					tone === "ours" && "text-warning-text",
					tone === "theirs" && "text-info-text",
					tone === "quiet" && "text-muted-foreground",
				)}
			/>
			<div className="min-w-0">
				<div className="truncate font-medium">{title}</div>
				{detail && (
					<div className="truncate text-xs text-muted-foreground">{detail}</div>
				)}
			</div>
		</div>
	);
}

export function ItemCell({ item, order }: { item: Item; order: ReturnOrder }) {
	const request = order.requests[0];
	switch (item.kind) {
		case "arrived":
			return (
				<Line
					icon={PackageCheck}
					tone="ours"
					title={item.at ? `Arrived ${formatDate(item.at)}` : "Arrived"}
					detail="Not checked in"
				/>
			);
		case "coming":
			return (
				<Line
					icon={Truck}
					tone="theirs"
					title="On its way"
					detail={
						item.tracking?.status ? (
							<PackageWhere
								t={{ ...item.tracking, status: item.tracking.status }}
							/>
						) : (
							request?.trackingNumber && (
								<span className="font-mono">
									{request.carrier && `${request.carrier} `}
									{request.trackingNumber}
								</span>
							)
						)
					}
				/>
			);
		case "asked":
			return (
				<Line
					icon={Clock}
					tone="quiet"
					title="Not shipped yet"
					detail={request && `Asked ${formatDate(request.requestedAt)}`}
				/>
			);
		case "refunded_not_back":
			return (
				<Line
					icon={Undo2}
					tone="ours"
					title="Not back"
					detail="Refunded in full"
				/>
			);
		case "maybe":
			return (
				<Line
					icon={CircleHelp}
					tone="quiet"
					title="Maybe coming"
					detail="Refunded in part"
				/>
			);
		case "back":
			return (
				<Line
					icon={CircleCheck}
					tone="settled"
					title={`Back ${formatDate(item.at)}`}
					detail={OUTCOME[item.outcome]}
				/>
			);
		case "not_coming":
			return <Line icon={Ban} tone="quiet" title="Not coming back" />;
		case "not_expected":
			return <Line icon={Clock} tone="quiet" title="Not expected" />;
	}
}

export function RefundCell({ refund, due }: { refund: Refund; due: boolean }) {
	switch (refund.kind) {
		case "refunded":
			return (
				<Line
					icon={CircleCheck}
					tone="settled"
					title={<span className="tabular-nums">{money(refund.amount)}</span>}
					detail="Refunded"
				/>
			);
		case "asked":
			return (
				<Line
					icon={Clock}
					tone={due ? "ours" : "quiet"}
					title={<span className="tabular-nums">{money(refund.amount)}</span>}
					detail="Asked, not refunded"
				/>
			);
		case "none":
			return (
				<Line icon={Clock} tone={due ? "ours" : "quiet"} title="Not refunded" />
			);
	}
}
