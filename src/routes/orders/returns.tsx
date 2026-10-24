import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	Ban,
	ExternalLink,
	PackageOpen,
	Printer,
	Search,
	SearchX,
	Undo2,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChannelBadge } from "#/components/channel-badge";
import { conditionName } from "#/components/order-page/return-card";
import { OrderTabs, ReturnsViews } from "#/components/order-tabs";
import { OrderProducts } from "#/components/orders-list/order-products";
import { Badge, Card, EmptyState, Page, type Tone } from "#/components/page";
import { type Received, ReturnDialog } from "#/components/return-dialog";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import type { ReturnState } from "#/db/schema";
import { formatCount, formatOrderDate } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism, optimistic, type Patch } from "#/lib/optimism";
import { useRowLink } from "#/lib/row-link";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { returnReason } from "#/orders/return-reasons";
import type { ReturnOrder } from "#/orders/returns-due";
import { printPdf } from "#/printing/qz-client";
import {
	getReturns,
	markOrderNoReturn,
	type ReturnsData,
	receiveOrderReturn,
	searchReturnable,
	undoOrderNoReturn,
	undoOrderReturn,
} from "#/server/orders";

export const Route = createFileRoute("/orders/returns")({
	loader: () => getReturns(),
	component: Returns,
	pendingComponent: () => (
		<ListSkeleton title="Orders" width="wide">
			<ListCard tabs />
		</ListSkeleton>
	),
});

const returnsData = optimistic<ReturnsData>("returns");

const states: Record<
	ReturnState,
	{ label: string; tone?: Tone; heading: string }
> = {
	on_its_way: { label: "On its way", tone: "info", heading: "On its way" },
	requested: {
		label: "Requested",
		tone: "info",
		heading: "Requested, not sent yet",
	},
	refunded: {
		label: "Refunded, not back",
		tone: "warning",
		heading: "Refunded, not back yet",
	},
	maybe: { label: "Maybe", heading: "Refunded in part, maybe coming back" },
};

// Receiving takes what came back off what's expected; an order with nothing
// left expected (or a maybe, once anything is back) leaves the list. Undo
// shows it again when the page reloads.
const receivedPatch = (orderId: number, received: Received[]): Patch =>
	returnsData.patch("all", (d) => ({
		...d,
		due: d.due.flatMap((o) => {
			if (o.id !== orderId) return [o];
			if (o.state === "maybe") return [];
			const lines = o.lines.map((l) => {
				const n = received.find((r) => r.lineId === l.id)?.quantity ?? 0;
				return {
					...l,
					left: l.left - n,
					expected: Math.max(0, l.expected - n),
				};
			});
			return lines.some((l) => l.expected > 0) ? [{ ...o, lines }] : [];
		}),
	}));

const dismissedPatch = (orderId: number): Patch =>
	returnsData.patch("all", (d) => ({
		...d,
		due: d.due.filter((o) => o.id !== orderId),
	}));

type ReceivedRow = ReturnsData["received"][number];

const unreceivedPatch = (id: number): Patch =>
	returnsData.patch("all", (d) => ({
		...d,
		received: d.received.filter((r) => r.id !== id),
	}));

// Nothing to lay over: the reload shows the order again.
const reloadOnly = returnsData.patch("all", (d) => d);

function matches(o: ReturnOrder, q: string) {
	const words = q.toLowerCase().replace(/#/g, "").split(/\s+/).filter(Boolean);
	const hay = [
		o.name,
		o.externalId,
		o.marketplaceOrderId,
		o.customerName,
		o.shipCity,
		o.shipPostalCode,
		...o.lines.flatMap((l) => [l.sku, l.title]),
		...o.requests.map((r) => r.trackingNumber),
		...o.unmatched.map((u) => u.sku),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase()
		.replace(/#/g, "");
	return words.every((w) => hay.includes(w));
}

// The search for orders not due back: the query it answers, and what came back.
type OtherSearch =
	| { q: string; state: "done"; rows: ReturnOrder[] }
	| { q: string; state: "failed" };

function Returns() {
	const loaded = Route.useLoaderData();
	const { due, received } = returnsData.useData("all", loaded);
	const navigate = useNavigate();
	const { link } = useRowLink();
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLTableSectionElement>(null);
	const [query, setQuery] = useState("");
	const [others, setOthers] = useState<OtherSearch | null>(null);
	const [selected, setSelected] = useState(0);
	const [receiving, setReceiving] = useState<ReturnOrder | null>(null);

	const shown = useMemo(
		() => (query.trim() ? due.filter((o) => matches(o, query)) : due),
		[due, query],
	);
	// Orders that can take a return but aren't expected to, for a box that
	// turns up first. Asked for once typing pauses.
	useEffect(() => {
		const q = query.trim();
		if (q.length < 3) return;
		// A search that a later query has overtaken is dropped, so an older
		// answer never replaces a newer one.
		let current = true;
		const timer = setTimeout(() => {
			searchReturnable({ data: { q } }).then(
				(rows) => {
					if (current) setOthers({ q, state: "done", rows });
				},
				() => {
					if (current) setOthers({ q, state: "failed" });
				},
			);
		}, 250);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [query]);
	const found =
		query.trim().length >= 3 && others?.q === query.trim() ? others : null;
	const extra = found?.state === "done" ? found.rows : [];
	const extraFailed = found?.state === "failed";
	const rows = [...shown, ...extra];

	// biome-ignore lint/correctness/useExhaustiveDependencies: back to the top when the search changes
	useEffect(() => setSelected(0), [query]);
	useEffect(() => {
		list.current
			?.querySelector(`[data-index="${selected}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	function receive(o: ReturnOrder | undefined) {
		if (!o) return;
		if (o.blocker) {
			toast.error(`Can't receive ${o.name} here`, { description: o.blocker });
			return;
		}
		setReceiving(o);
	}

	async function nothingComing(o: ReturnOrder | undefined) {
		if (!o?.state) return;
		const r = await optimism.change({
			label: `Nothing coming back on ${o.name}`,
			patch: dismissedPatch(o.id),
			send: () => markOrderNoReturn({ data: { orderId: o.id } }),
		});
		if (!r) return;
		offerUndo(`Nothing coming back on ${o.name}`, {
			description:
				o.state === "refunded"
					? "Its items count as a cost now"
					: "It's off the list",
			undo: async () => {
				const undone = await optimism.change({
					label: `Undoing on ${o.name}`,
					patch: reloadOnly,
					send: () =>
						undoOrderNoReturn({
							data: { orderId: o.id, previous: r.value.previous },
						}),
				});
				return undone && `${o.name} is back on Returns`;
			},
		});
	}

	// Takes a received return back off, long after its own Undo toast is
	// gone: restocked units leave the shelf and the order is due again.
	async function unreceive(r: ReceivedRow) {
		const what = `${formatCount(r.quantity)} × ${r.sku ?? r.title}`;
		const done = await optimism.change({
			label: `Taking back return on ${r.name}`,
			patch: unreceivedPatch(r.id),
			send: () => undoOrderReturn({ data: { ids: [r.id] } }),
		});
		if (!done) return;
		if (done.value.problems.length > 0)
			toast.error(done.value.problems.join("; "));
		offerUndo(`Return on ${r.name} taken back`, {
			description: r.restocked || r.refurb ? `${what} off the shelf` : what,
			undo: async () => {
				const again = await optimism.change({
					label: `Return on ${r.name}`,
					patch: reloadOnly,
					send: () =>
						receiveOrderReturn({
							data: {
								orderId: r.orderId,
								lines: [{ lineId: r.lineId, quantity: r.quantity }],
								outcome: r.refurb
									? { refurbishInto: r.refurb.id }
									: r.restocked
										? "restock"
										: "write_off",
							},
						}),
				});
				return again && `Return on ${r.name} received again`;
			},
		});
	}

	useHotkeys({
		"/": (e) => {
			e.preventDefault();
			input.current?.focus();
		},
		Escape: () => {
			if (document.activeElement === input.current) input.current?.blur();
			else if (query) setQuery("");
		},
		j: () => setSelected((i) => Math.min(i + 1, rows.length - 1)),
		k: () => setSelected((i) => Math.max(i - 1, 0)),
		Enter: () => receive(rows[selected]),
		o: () => {
			const o = rows[selected];
			if (o) navigate({ to: "/orders/$id", params: { id: String(o.id) } });
		},
		n: () => nothingComing(rows[selected]),
	});

	let index = 0;
	const row = (o: ReturnOrder) => {
		const i = index++;
		return (
			<ReturnRow
				key={o.id}
				order={o}
				index={i}
				selected={i === selected}
				onHover={() => setSelected(i)}
				onReceive={() => receive(o)}
				onNothing={o.state ? () => nothingComing(o) : undefined}
				link={link}
			/>
		);
	};
	const groups = (Object.keys(states) as ReturnState[])
		.map((s) => ({ state: s, orders: shown.filter((o) => o.state === s) }))
		.filter((g) => g.orders.length > 0);

	return (
		<Page title="Orders" width="wide">
			<Card flush className="overflow-visible">
				<OrderTabs
					active="returns"
					count={due.length}
					aside={<ReturnsViews active="due" />}
				/>
				<div className="border-b p-2">
					<div className="relative">
						<Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" />
						<input
							ref={input}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									receive(rows[selected]);
								} else if (e.key === "ArrowDown") {
									e.preventDefault();
									setSelected((i) => Math.min(i + 1, rows.length - 1));
								} else if (e.key === "ArrowUp") {
									e.preventDefault();
									setSelected((i) => Math.max(i - 1, 0));
								}
							}}
							placeholder="What's on the box: order number, name, city, zip, SKU, tracking"
							className="h-8 w-full rounded-lg border border-input bg-white pr-3 pl-8 outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
						/>
					</div>
				</div>

				{extraFailed && rows.length === 0 ? (
					<EmptyState icon={Search} title="Search didn't finish">
						Type to search again.
					</EmptyState>
				) : rows.length === 0 ? (
					query.trim() ? (
						<EmptyState icon={SearchX} title="No order matches">
							{query.trim().length < 3
								? "Type a few more letters to search every order."
								: "Try the buyer's name, a SKU, or the zip on the label."}
						</EmptyState>
					) : (
						<EmptyState icon={PackageOpen} title="Nothing due back" />
					)
				) : (
					<table className="w-full whitespace-nowrap">
						<thead>
							<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
								<th className="px-4 py-2 font-medium">Order</th>
								<th className="hidden px-4 py-2 font-medium md:table-cell">
									Date
								</th>
								<th className="px-4 py-2 font-medium">Customer</th>
								<th className="hidden px-4 py-2 font-medium md:table-cell">
									Coming back
								</th>
								<th className="hidden px-4 py-2 font-medium lg:table-cell">
									Why
								</th>
								<th className="hidden px-4 py-2 font-medium lg:table-cell">
									Channel
								</th>
								<th className="px-4 py-2 font-medium">Status</th>
								<th className="w-0 px-2 py-2" />
							</tr>
						</thead>
						<tbody ref={list}>
							{groups.map((g) => (
								<Fragment key={g.state}>
									<GroupHeading>
										{states[g.state].heading}
										<span className="ml-1.5 tabular-nums">
											{formatCount(g.orders.length)}
										</span>
									</GroupHeading>
									{g.orders.map(row)}
								</Fragment>
							))}
							{extraFailed && (
								<tr>
									<td
										colSpan={COLUMNS}
										className="px-4 py-2 text-xs text-warning-text"
									>
										Couldn't search every order. Type to search again.
									</td>
								</tr>
							)}
							{extra.length > 0 && (
								<>
									<GroupHeading>Other orders that match</GroupHeading>
									{extra.map(row)}
								</>
							)}
						</tbody>
					</table>
				)}
			</Card>

			{received.length > 0 && !query.trim() && (
				<Card title="Received in the last 30 days" flush>
					<table className="w-full whitespace-nowrap">
						<tbody>
							{received.map((r) => (
								<tr
									key={r.id}
									{...link({
										to: "/orders/$id",
										params: { id: String(r.orderId) },
									})}
									className="cursor-pointer border-t hover:bg-subtle"
								>
									<td className="w-40 px-4 py-2.5 font-semibold">{r.name}</td>
									<td className="hidden w-40 px-4 py-2.5 text-muted-foreground md:table-cell">
										{formatOrderDate(r.createdAt)}
									</td>
									<td className="max-w-0 px-4 py-2.5">
										<div className="flex min-w-0 items-center gap-2">
											<span className="shrink-0 font-semibold tabular-nums">
												{formatCount(r.quantity)} ×
											</span>
											<span className="truncate">{r.sku ?? r.title}</span>
										</div>
									</td>
									<td className="w-0 px-4 py-2.5">
										{r.refurb ? (
											<Badge tone="success">
												{conditionName(r.refurb.condition)} · {r.refurb.sku}
											</Badge>
										) : (
											<Badge tone={r.restocked ? "success" : undefined}>
												{r.restocked ? "Back on shelf" : "Written off"}
											</Badge>
										)}
									</td>
									<td className="w-0 py-1.5 pr-2">
										<div className="flex items-center justify-end gap-1">
											{r.confirmOn && (
												<a
													href={r.confirmOn.url}
													target="_blank"
													rel="noreferrer"
													className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-link hover:bg-surface-strong"
												>
													Confirm on {r.confirmOn.name}
													<ExternalLink className="size-3.5" />
												</a>
											)}
											{r.refurb && (
												<Tip content="Print its box label">
													<button
														type="button"
														aria-label="Print its box label"
														onClick={() =>
															printPdf(`/labels/refurbs/${r.id}`, "Box label")
														}
														className={ICON_BUTTON}
													>
														<Printer className="size-4" />
													</button>
												</Tip>
											)}
											<Tip content="Take this return back">
												<button
													type="button"
													aria-label="Take this return back"
													onClick={() => unreceive(r)}
													className={ICON_BUTTON}
												>
													<Undo2 className="size-4" />
												</button>
											</Tip>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</Card>
			)}

			{receiving && (
				<ReturnDialog
					key={receiving.id}
					open
					onOpenChange={(open) => !open && setReceiving(null)}
					orderId={receiving.id}
					orderName={receiving.name}
					lines={receiving.lines.map((l) => ({
						...l,
						// Expected units first; a search hit expects nothing, so all.
						start:
							receiving.state && receiving.state !== "maybe"
								? l.expected
								: l.left,
					}))}
					patches={{
						// The box is done: the search clears for the next one.
						receive: (got) => {
							setQuery("");
							setOthers(null);
							return receivedPatch(receiving.id, got);
						},
						undo: () => reloadOnly,
					}}
				/>
			)}
		</Page>
	);
}

const COLUMNS = 8;
const ICON_BUTTON =
	"inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-strong hover:text-foreground";

function GroupHeading({ children }: { children: React.ReactNode }) {
	return (
		<tr>
			<td
				colSpan={COLUMNS}
				className="border-y bg-subtle px-4 py-1.5 text-xs font-medium text-muted-foreground"
			>
				{children}
			</td>
		</tr>
	);
}

// One order with something coming back, laid out as the orders list lays
// out an order. A click opens the order, where its whole return is; Enter
// (or the row's Receive) opens the box.
function ReturnRow({
	order: o,
	index,
	selected,
	onHover,
	onReceive,
	onNothing,
	link,
}: {
	order: ReturnOrder;
	index: number;
	selected: boolean;
	onHover: () => void;
	onReceive: () => void;
	onNothing?: () => void;
	link: ReturnType<typeof useRowLink>["link"];
}) {
	const state = o.state ? states[o.state] : null;
	const request = o.requests[0];
	const expected = o.lines.filter((l) => l.expected > 0);
	const coming = (expected.length > 0 ? expected : o.lines).map((l) => ({
		id: l.id,
		title: l.title,
		sku: l.sku,
		quantity: l.expected || l.left,
		productSku: null,
		productName: null,
		imageUrl: l.imageUrl,
		fromStore: [],
	}));
	const why = [
		request?.reason && returnReason(request.reason),
		request?.trackingNumber &&
			`${request.carrier ? `${request.carrier} ` : ""}${request.trackingNumber}`,
	].filter(Boolean);
	return (
		<tr
			data-index={index}
			{...link({ to: "/orders/$id", params: { id: String(o.id) } })}
			onMouseMove={onHover}
			className={cn(
				"group cursor-pointer border-t first:border-t-0",
				selected ? "bg-surface" : "hover:bg-subtle",
			)}
		>
			<td className="px-4 py-2.5 font-semibold">{o.name}</td>
			<td className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">
				{formatOrderDate(o.placedAt)}
			</td>
			<td className="w-2/5 max-w-0 px-4 py-2.5">
				<div className="truncate">{o.customerName ?? "No name"}</div>
				<div className="truncate text-xs text-muted-foreground">
					{[o.shipCity, o.shipRegion].filter(Boolean).join(", ")}
					{o.shipPostalCode && ` ${o.shipPostalCode}`}
				</div>
			</td>
			<td className="hidden w-3/5 max-w-0 px-4 py-2 md:table-cell">
				<OrderProducts lines={coming} />
			</td>
			<td className="hidden max-w-56 px-4 py-2.5 lg:table-cell">
				<div className="truncate text-muted-foreground">{why.join(" · ")}</div>
				{o.unmatched.map((u, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: two requests can name the same SKU
						key={i}
						className="truncate text-xs text-warning-text"
					>
						{formatCount(u.quantity)} × {u.sku ?? "an item"}, line unclear
					</div>
				))}
			</td>
			<td className="hidden px-4 py-2.5 lg:table-cell">
				<ChannelBadge channel={o.channel} salesChannel={o.salesChannel} />
			</td>
			<td className="px-4 py-2.5">
				<div className="flex gap-1.5">
					{state ? (
						<Badge tone={state.tone}>{state.label}</Badge>
					) : (
						<Badge>Not expected</Badge>
					)}
					{o.blocker && (
						<Tip content={o.blocker}>
							<span>
								<Badge tone="warning">Can't receive here</Badge>
							</span>
						</Tip>
					)}
				</div>
			</td>
			<td className="py-1.5 pr-2">
				<div className="flex items-center justify-end gap-1">
					{!o.blocker && (
						<Button
							size="sm"
							variant={selected ? "default" : "outline"}
							onClick={onReceive}
						>
							Receive
							{selected && (
								<kbd className="ml-1 rounded bg-white/15 px-1 text-xs">↵</kbd>
							)}
						</Button>
					)}
					{onNothing ? (
						<Tip content="Nothing coming back (n)">
							<button
								type="button"
								aria-label="Nothing coming back"
								onClick={onNothing}
								className={ICON_BUTTON}
							>
								<Ban className="size-4" />
							</button>
						</Tip>
					) : (
						<span className="size-7" />
					)}
				</div>
			</td>
		</tr>
	);
}
