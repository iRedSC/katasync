import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	AlertTriangle,
	Copy,
	ExternalLink,
	FileText,
	Link2,
	PackageCheck,
	Printer,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { MatchDialog } from "#/components/match-picker";
import { Badge, Card, EmptyState, Page } from "#/components/page";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { copyText } from "#/lib/copy";
import { formatCount, formatMoney, formatOrderDate } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { useRowLink } from "#/lib/row-link";
import { cn } from "#/lib/utils";
import { externalFulfillment } from "#/orders/fulfillment";
import { orderStatus } from "#/orders/status";
import { listOrders, type OrderRow } from "#/server/orders";

type View = "ship" | "all";

export const Route = createFileRoute("/orders/")({
	validateSearch: (search: Record<string, unknown>): { view?: View } =>
		search.view === "all" ? { view: "all" } : {},
	loaderDeps: ({ search }) => ({ view: search.view ?? "ship" }),
	loader: ({ deps }) => listOrders({ data: { view: deps.view } }),
	component: Orders,
	pendingComponent: () => (
		<ListSkeleton title="Orders">
			<ListCard tabs />
		</ListSkeleton>
	),
});

const views: { key: View; label: string }[] = [
	{ key: "ship", label: "To ship" },
	{ key: "all", label: "All orders" },
];

function Orders() {
	const rows = Route.useLoaderData();
	const { view = "ship" } = Route.useSearch();
	const navigate = useNavigate();
	const { link, preload, load } = useRowLink();
	const list = useRef<HTMLTableSectionElement>(null);
	const [selected, setSelected] = useState(0);
	const [menuFor, setMenuFor] = useState<OrderRow | null>(null);
	const [matchingId, setMatchingId] = useState<number | null>(null);
	const closeMatch = useCallback(() => setMatchingId(null), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the view changes
	useEffect(() => setSelected(0), [view]);
	const to = (o: OrderRow) =>
		({ to: "/orders/$id", params: { id: String(o.id) } }) as const;
	// biome-ignore lint/correctness/useExhaustiveDependencies: follows the selection, not each reload of the rows
	useEffect(() => {
		list.current
			?.querySelector(`[data-index="${selected}"]`)
			?.scrollIntoView({ block: "nearest" });
		// Enter opens the selected order, so it's loaded ahead too.
		const o = rows[selected];
		if (o) preload(to(o));
	}, [selected, preload]);

	const open = (o: OrderRow | undefined) => o && navigate(to(o));

	// Nearly every order to ship gets opened, one after another, so each
	// loads as it scrolls into view rather than waiting for a hover. All
	// orders is too long to load whole.
	// biome-ignore lint/correctness/useExhaustiveDependencies: watches the rows shown, not each reload's copy of them
	useEffect(() => {
		const body = list.current;
		if (view !== "ship" || !body) return;
		const seen = new IntersectionObserver((entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				seen.unobserve(e.target);
				const o = rows[Number((e.target as HTMLElement).dataset.index)];
				if (o) load(to(o));
			}
		});
		for (const tr of body.querySelectorAll("tr[data-index]")) seen.observe(tr);
		return () => seen.disconnect();
	}, [view, rows.map((o) => o.id).join(), load]);

	useHotkeys({
		j: () => setSelected((i) => Math.min(i + 1, rows.length - 1)),
		k: () => setSelected((i) => Math.max(i - 1, 0)),
		Enter: () => open(rows[selected]),
	});

	return (
		<Page
			title="Orders"
			actions={
				view === "ship" &&
				rows.length > 0 && (
					<Button asChild variant="outline" size="sm">
						<a href="/print/invoices" target="_blank" rel="noreferrer">
							<Printer />
							Print all
						</a>
					</Button>
				)
			}
		>
			<Card flush>
				<div className="flex gap-1 border-b p-2">
					{views.map((v) => (
						<button
							key={v.key}
							type="button"
							onClick={() =>
								navigate({
									to: "/orders",
									search: v.key === "ship" ? {} : { view: v.key },
								})
							}
							className={cn(
								"inline-flex h-7 items-center rounded-lg px-2.5 font-medium",
								view === v.key
									? "bg-surface-strong text-foreground"
									: "text-muted-foreground hover:bg-surface hover:text-foreground",
							)}
						>
							{v.label}
							{v.key === view && (
								<span className="ml-1.5 text-muted-foreground tabular-nums">
									{formatCount(rows.length)}
								</span>
							)}
						</button>
					))}
				</div>

				{rows.length === 0 ? (
					<EmptyState
						icon={PackageCheck}
						title={view === "ship" ? "Nothing to ship" : "No orders"}
					/>
				) : (
					// No cell wraps; the customer column takes what's left and truncates.
					<table className="w-full whitespace-nowrap">
						<thead>
							<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
								{view === "ship" && (
									<th className="w-16 px-4 py-2 font-medium">Pin</th>
								)}
								<th className="px-4 py-2 font-medium">Order</th>
								<th className="hidden px-4 py-2 font-medium md:table-cell">
									Date
								</th>
								<th className="px-4 py-2 font-medium">Customer</th>
								<th className="hidden px-4 py-2 font-medium lg:table-cell">
									Channel
								</th>
								<th className="px-4 py-2 text-right font-medium">Total</th>
								<th className="hidden px-4 py-2 font-medium md:table-cell">
									Items
								</th>
								<th className="px-4 py-2 font-medium">Status</th>
							</tr>
						</thead>
						{/* One menu for the whole table: it acts on the row that was
						    right-clicked. */}
						<ContextMenu>
							<ContextMenuTrigger asChild>
								<tbody ref={list}>
									{rows.map((o, i) => {
										const status = orderStatus(o);
										const external = externalFulfillment(o);
										return (
											<tr
												key={o.id}
												data-index={i}
												{...link(to(o))}
												onMouseMove={() => setSelected(i)}
												onContextMenu={() => setMenuFor(o)}
												className={cn(
													"cursor-pointer border-t first:border-t-0",
													i === selected ? "bg-surface" : "hover:bg-subtle",
												)}
											>
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
												{/* Takes the leftover width; long names end in "…". */}
												<td className="w-full max-w-0 px-4 py-2.5">
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
													{formatCount(o.items)}{" "}
													{o.items === 1 ? "item" : "items"}
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
								<OrderMenu
									order={menuFor}
									onMatch={() => setMatchingId(menuFor.id)}
								/>
							)}
						</ContextMenu>
					</table>
				)}
			</Card>
			<MatchDialog orderId={matchingId} onClose={closeMatch} />
		</Page>
	);
}

// Only the actions this row's data supports. Shipping, returns, and voiding
// stay on the order's page: the review items just take you there.
function OrderMenu({
	order: o,
	onMatch,
}: {
	order: OrderRow;
	onMatch: () => void;
}) {
	const navigate = useNavigate();
	const external = externalFulfillment(o);

	return (
		<ContextMenuContent>
			<ContextMenuItem
				shortcut="↵"
				onSelect={() =>
					navigate({ to: "/orders/$id", params: { id: String(o.id) } })
				}
			>
				<FileText />
				Open
			</ContextMenuItem>
			<ContextMenuItem
				onSelect={() => window.open(`/orders/${o.id}`, "_blank")}
			>
				<ExternalLink />
				Open in new tab
			</ContextMenuItem>
			<ContextMenuItem
				onSelect={() => window.open(`/print/invoices?id=${o.id}`, "_blank")}
			>
				<Printer />
				Print invoice
			</ContextMenuItem>
			{external && (
				<ContextMenuItem onSelect={() => window.open(external.url, "_blank")}>
					<ExternalLink />
					Fulfill on {external.name}
				</ContextMenuItem>
			)}
			{o.labelToVoid && (
				<ContextMenuItem
					onSelect={() =>
						navigate({ to: "/orders/$id", params: { id: String(o.id) } })
					}
				>
					<AlertTriangle />
					Review label to void
				</ContextMenuItem>
			)}
			{o.unmatched > 0 && (
				<ContextMenuItem onSelect={onMatch}>
					<Link2 />
					Match
				</ContextMenuItem>
			)}
			<ContextMenuSeparator />
			<ContextMenuItem onSelect={() => copyText(o.name)}>
				<Copy />
				Copy order name
			</ContextMenuItem>
		</ContextMenuContent>
	);
}
