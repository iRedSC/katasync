import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ExternalLink, PackageCheck, Printer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge, Card, EmptyState, Page } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatCount, formatMoney, formatOrderDate } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
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
});

const views: { key: View; label: string }[] = [
	{ key: "ship", label: "To ship" },
	{ key: "all", label: "All orders" },
];

function Orders() {
	const rows = Route.useLoaderData();
	const { view = "ship" } = Route.useSearch();
	const navigate = useNavigate();
	const list = useRef<HTMLTableSectionElement>(null);
	const [selected, setSelected] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the view changes
	useEffect(() => setSelected(0), [view]);
	useEffect(() => {
		list.current
			?.querySelector(`[data-index="${selected}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	const open = (o: OrderRow | undefined) =>
		o && navigate({ to: "/orders/$id", params: { id: String(o.id) } });

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
						title={view === "ship" ? "Nothing to ship" : "No orders yet"}
					>
						{view === "ship"
							? "Every order is packed and out the door. New ones show up here within a couple of minutes."
							: "Orders show up here once a store syncs."}
					</EmptyState>
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
						<tbody ref={list}>
							{rows.map((o, i) => {
								const status = orderStatus(o);
								const external = externalFulfillment(o);
								return (
									<tr
										key={o.id}
										data-index={i}
										onClick={() => open(o)}
										onMouseMove={() => setSelected(i)}
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
					</table>
				)}
			</Card>
		</Page>
	);
}
