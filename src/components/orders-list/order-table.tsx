import { ExternalLink } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge } from "#/components/page";
import { ContextMenu, ContextMenuTrigger } from "#/components/ui/context-menu";
import { formatCount, formatMoney, formatOrderDate } from "#/lib/format";
import type { useRowLink } from "#/lib/row-link";
import { cn } from "#/lib/utils";
import { externalFulfillment } from "#/orders/fulfillment";
import { orderStatus } from "#/orders/status";
import type { OrderRow } from "#/server/orders";
import { OrderMenu } from "./order-menu";
import { OrderProducts } from "./order-products";
import { headerState, type Ticks } from "./selection";

export const orderLink = (o: OrderRow) =>
	({ to: "/orders/$id", params: { id: String(o.id) } }) as const;

// The orders shown, each with a box to tick it for printing. `cursor` is the
// row j and k move and Enter opens; x ticks it.
export function OrderTable({
	rows,
	view,
	bodyRef,
	cursor,
	onCursor,
	ticks,
	onTick,
	onTickAll,
	link,
	onMatch,
}: {
	rows: readonly OrderRow[];
	view: "ship" | "all";
	bodyRef: RefObject<HTMLTableSectionElement | null>;
	cursor: number;
	onCursor: (i: number) => void;
	ticks: Ticks;
	onTick: (i: number, range: boolean) => void;
	onTickAll: () => void;
	link: ReturnType<typeof useRowLink>["link"];
	onMatch: (id: number) => void;
}) {
	const [menuFor, setMenuFor] = useState<OrderRow | null>(null);
	const header = headerState(ticks, rows);

	return (
		// No cell wraps; the customer and products columns share what's left and
		// truncate.
		<table className="w-full whitespace-nowrap">
			<thead>
				<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
					<TickCell as="th" onClick={onTickAll}>
						<TickBox
							label={header === "all" ? "Untick all shown" : "Tick all shown"}
							checked={header === "all"}
							indeterminate={header === "some"}
						/>
					</TickCell>
					{view === "ship" && (
						<th className="w-16 px-4 py-2 font-medium">Pin</th>
					)}
					<th className="px-4 py-2 font-medium">Order</th>
					<th className="hidden px-4 py-2 font-medium md:table-cell">Date</th>
					<th className="px-4 py-2 font-medium">Customer</th>
					<th className="hidden px-4 py-2 font-medium md:table-cell">
						Products
					</th>
					<th className="hidden px-4 py-2 font-medium lg:table-cell">
						Channel
					</th>
					<th className="px-4 py-2 text-right font-medium">Total</th>
					<th className="hidden px-4 py-2 font-medium md:table-cell">Items</th>
					<th className="px-4 py-2 font-medium">Status</th>
				</tr>
			</thead>
			{/* One menu for the whole table: it acts on the row that was
			    right-clicked. */}
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<tbody ref={bodyRef}>
						{rows.map((o, i) => {
							const status = orderStatus(o);
							const external = externalFulfillment(o);
							const ticked = ticks.has(o.id);
							return (
								<tr
									key={o.id}
									data-index={i}
									{...link(orderLink(o))}
									onMouseMove={() => onCursor(i)}
									onContextMenu={() => setMenuFor(o)}
									className={cn(
										"cursor-pointer border-t first:border-t-0",
										i === cursor
											? "bg-surface"
											: ticked
												? "bg-subtle"
												: "hover:bg-subtle",
									)}
								>
									<TickCell as="td" onClick={(range) => onTick(i, range)}>
										<TickBox
											label={`${ticked ? "Untick" : "Tick"} ${o.name}`}
											checked={ticked}
										/>
									</TickCell>
									{view === "ship" && (
										<td className="px-4 py-2.5 font-mono text-base font-bold tabular-nums">
											{o.pin}
										</td>
									)}
									<td className="px-4 py-2.5 font-semibold">
										{external ? (
											// Opens the marketplace's page; the rest of the row
											// still opens katasync's.
											<a
												href={external.url}
												target="_blank"
												rel="noreferrer"
												onClick={(e) => e.stopPropagation()}
												className="inline-flex items-center gap-1 text-link hover:underline"
											>
												{o.name}
												<ExternalLink className="size-3.5" />
											</a>
										) : (
											o.name
										)}
									</td>
									<td className="hidden px-4 py-2.5 whitespace-nowrap text-muted-foreground md:table-cell">
										{formatOrderDate(o.placedAt)}
									</td>
									{/* Shares the leftover width; long names end in "…". */}
									<td className="w-2/5 max-w-0 px-4 py-2.5">
										<div className="truncate">
											{o.customerName ?? "No name"}
										</div>
										{o.shipCity && (
											<div className="truncate text-xs text-muted-foreground">
												{o.shipCity}
												{o.shipRegion && `, ${o.shipRegion}`}
											</div>
										)}
									</td>
									{/* Shares the leftover width with the customer. */}
									<td className="hidden w-3/5 max-w-0 px-4 py-2 md:table-cell">
										<OrderProducts lines={o.lines} />
									</td>
									<td className="hidden px-4 py-2.5 lg:table-cell">
										<ChannelBadge
											channel={o.channel}
											salesChannel={o.salesChannel}
										/>
									</td>
									<td className="px-4 py-2.5 text-right tabular-nums">
										{formatMoney(o.total)}
									</td>
									<td className="hidden px-4 py-2.5 whitespace-nowrap md:table-cell">
										{formatCount(o.items)} {o.items === 1 ? "item" : "items"}
									</td>
									<td className="px-4 py-2.5">
										<div className="flex gap-1.5">
											<Badge tone={status.tone}>{status.label}</Badge>
											{o.unmatched > 0 && (
												<Badge tone="critical">Unknown product</Badge>
											)}
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</ContextMenuTrigger>
				{menuFor && (
					<OrderMenu order={menuFor} onMatch={() => onMatch(menuFor.id)} />
				)}
			</ContextMenu>
		</table>
	);
}

// The box's whole cell ticks, so a near miss doesn't open the order instead.
// `range` is a shift-click. A click on the box itself, or Space on it,
// lands here too.
function TickCell({
	as: Cell,
	onClick,
	children,
}: {
	as: "td" | "th";
	onClick: (range: boolean) => void;
	children: ReactNode;
}) {
	return (
		<Cell
			onClick={(e) => {
				e.stopPropagation();
				onClick(e.shiftKey);
			}}
			onAuxClick={(e) => e.stopPropagation()}
			// Enter on the box mustn't also open the row.
			onKeyDown={(e) => e.stopPropagation()}
			className="w-10 cursor-pointer py-2 pr-1 pl-4 select-none"
		>
			{children}
		</Cell>
	);
}

function TickBox({
	label,
	checked,
	indeterminate = false,
}: {
	label: string;
	checked: boolean;
	indeterminate?: boolean;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = indeterminate;
	}, [indeterminate]);
	return (
		<input
			ref={ref}
			type="checkbox"
			aria-label={label}
			checked={checked}
			// The cell around it does the ticking.
			onChange={() => {}}
			className="size-4 cursor-pointer align-middle"
		/>
	);
}
