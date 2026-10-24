import { ExternalLink } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { OrderStatusBadge } from "#/components/order-status";
import { Badge } from "#/components/page";
import { TickCell } from "#/components/tick-cell";
import { ContextMenu, ContextMenuTrigger } from "#/components/ui/context-menu";
import { formatMoney, formatOrderDate } from "#/lib/format";
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
	// No clock until mounted, so the server and the first client render print
	// the same dates; "Today" and "Yesterday" come in once the browser has one.
	const [now, setNow] = useState<Date | null>(null);
	useEffect(() => {
		setNow(new Date());
	}, []);

	return (
		// No cell wraps; the customer and products columns share what's left and
		// truncate.
		<table className="w-full whitespace-nowrap">
			<thead>
				<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
					<TickCell
						as="th"
						label={header === "all" ? "Untick all shown" : "Tick all shown"}
						checked={header === "all"}
						mixed={header === "some"}
						onTick={onTickAll}
					/>
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
									<TickCell
										as="td"
										label={`${ticked ? "Untick" : "Tick"} ${o.name}`}
										checked={ticked}
										onTick={(range) => onTick(i, range)}
									/>
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
										{formatOrderDate(o.placedAt, now)}
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
									<td className="px-4 py-2.5">
										<div className="flex gap-1.5">
											<OrderStatusBadge status={status} />
											{o.unmatched > 0 && (
												<Badge tone="critical">Unknown product</Badge>
											)}
											{o.lines.some((l) => l.fromStore.length > 0) && (
												<Badge tone="warning">
													Fetch from{" "}
													{
														o.lines.find((l) => l.fromStore.length > 0)
															?.fromStore[0].location
													}
												</Badge>
											)}
											{/* Print all skips it, so the list says why. */}
											{view === "ship" && o.invoicePrintedAt && (
												<Badge>Printed</Badge>
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
