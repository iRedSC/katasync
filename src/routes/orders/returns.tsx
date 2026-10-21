import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	Ban,
	ExternalLink,
	PackageOpen,
	Printer,
	Search,
	Undo2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge, Card, EmptyState, Page, type Tone } from "#/components/page";
import { type Received, ReturnDialog } from "#/components/return-dialog";
import { ReturnsTabs } from "#/components/returns-tabs";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Tip } from "#/components/ui/tooltip";
import type { ReturnState } from "#/db/schema";
import { formatCount, formatOrderDate } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism, optimistic, type Patch } from "#/lib/optimism";
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
		<ListSkeleton title="Returns">
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

// A Shopify condition handle as words: "new-previous-gen" → "New previous gen".
const conditionName = (handle: string) =>
	handle.charAt(0).toUpperCase() + handle.slice(1).replace(/-/g, " ");

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

function Returns() {
	const loaded = Route.useLoaderData();
	const { due, received } = returnsData.useData("all", loaded);
	const navigate = useNavigate();
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");
	const [others, setOthers] = useState<{ q: string; rows: ReturnOrder[] }>({
		q: "",
		rows: [],
	});
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
		const timer = setTimeout(async () => {
			const rows = await searchReturnable({ data: { q } });
			setOthers({ q, rows });
		}, 250);
		return () => clearTimeout(timer);
	}, [query]);
	const extra =
		query.trim().length >= 3 && others.q === query.trim() ? others.rows : [];
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
			/>
		);
	};
	const groups = (Object.keys(states) as ReturnState[])
		.map((s) => ({ state: s, orders: shown.filter((o) => o.state === s) }))
		.filter((g) => g.orders.length > 0);

	return (
		<Page title="Returns">
			<Card flush>
				<ReturnsTabs active="due" due={due.length} />
				<div className="flex items-center gap-2 border-b px-4 py-2">
					<Search className="size-4 text-muted-foreground" />
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
						className="h-8 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
					/>
					<span className="hidden text-xs text-muted-foreground sm:inline">
						/ search · ↵ receive · o open · n nothing coming back
					</span>
				</div>

				<div ref={list}>
					{rows.length === 0 ? (
						query.trim() ? (
							<EmptyState icon={Search} title="No order matches">
								{query.trim().length < 3
									? "Type a few more letters to search every order."
									: "Nothing due back or shipped matches that. Try the buyer's name, a SKU, or the zip on the label."}
							</EmptyState>
						) : (
							<EmptyState icon={PackageOpen} title="Nothing due back">
								Refunds and return requests show here until their items are
								received.
							</EmptyState>
						)
					) : (
						<>
							{groups.map((g) => (
								<section key={g.state}>
									<GroupHeading>
										{states[g.state].heading}
										<span className="ml-1.5 tabular-nums">
											{formatCount(g.orders.length)}
										</span>
									</GroupHeading>
									{g.orders.map(row)}
								</section>
							))}
							{extra.length > 0 && (
								<section>
									<GroupHeading>Other orders that match</GroupHeading>
									{extra.map(row)}
								</section>
							)}
						</>
					)}
				</div>
			</Card>

			{received.length > 0 && !query.trim() && (
				<Card title="Received in the last 30 days" flush>
					<ul>
						{received.map((r) => (
							<li
								key={r.id}
								className="flex items-center border-t pr-2 first:border-t-0 hover:bg-subtle"
							>
								<Link
									to="/orders/$id"
									params={{ id: String(r.orderId) }}
									className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5"
								>
									<span className="w-28 shrink-0 text-muted-foreground">
										{formatOrderDate(r.createdAt)}
									</span>
									<span className="w-40 shrink-0 truncate font-semibold">
										{r.name}
									</span>
									<span className="min-w-0 flex-1 truncate">
										{formatCount(r.quantity)} × {r.sku ?? r.title}
									</span>
									{r.refurb ? (
										<Badge tone="success">
											{conditionName(r.refurb.condition)} · {r.refurb.sku}
										</Badge>
									) : (
										<Badge tone={r.restocked ? "success" : undefined}>
											{r.restocked ? "Back on shelf" : "Written off"}
										</Badge>
									)}
								</Link>
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
											className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-strong hover:text-foreground"
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
										className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-strong hover:text-foreground"
									>
										<Undo2 className="size-4" />
									</button>
								</Tip>
							</li>
						))}
					</ul>
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
							setOthers({ q: "", rows: [] });
							return receivedPatch(receiving.id, got);
						},
						undo: () => reloadOnly,
					}}
				/>
			)}
		</Page>
	);
}

function GroupHeading({ children }: { children: React.ReactNode }) {
	return (
		<div className="border-b bg-subtle px-4 py-1.5 text-xs font-medium text-muted-foreground">
			{children}
		</div>
	);
}

function ReturnRow({
	order: o,
	index,
	selected,
	onHover,
	onReceive,
	onNothing,
}: {
	order: ReturnOrder;
	index: number;
	selected: boolean;
	onHover: () => void;
	onReceive: () => void;
	onNothing?: () => void;
}) {
	const state = o.state ? states[o.state] : null;
	const request = o.requests[0];
	const expected = o.lines.filter((l) => l.expected > 0);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Enter receives the selected row
		// biome-ignore lint/a11y/noStaticElementInteractions: a row of a keyboard-driven list
		<div
			data-index={index}
			onMouseMove={onHover}
			onClick={onReceive}
			className={cn(
				"flex cursor-pointer items-start gap-4 border-b px-4 py-3 last:border-b-0",
				selected ? "bg-surface" : "hover:bg-subtle",
			)}
		>
			<div className="w-44 shrink-0">
				<Link
					to="/orders/$id"
					params={{ id: String(o.id) }}
					onClick={(e) => e.stopPropagation()}
					className="font-semibold text-link hover:underline"
				>
					{o.name}
				</Link>
				<div className="mt-1 flex items-center gap-1.5">
					<ChannelBadge channel={o.channel} salesChannel={o.salesChannel} />
				</div>
				<div className="mt-1 text-xs text-muted-foreground">
					{formatOrderDate(o.placedAt)}
				</div>
			</div>
			<div className="w-44 shrink-0 min-w-0">
				<div className="truncate">{o.customerName ?? "No name"}</div>
				<div className="truncate text-xs text-muted-foreground">
					{[o.shipCity, o.shipRegion].filter(Boolean).join(", ")}
					{o.shipPostalCode && ` ${o.shipPostalCode}`}
				</div>
			</div>
			<ul className="min-w-0 flex-1">
				{(expected.length > 0 ? expected : o.lines).map((l) => (
					<li key={l.id} className="truncate">
						<span className="tabular-nums">
							{o.state === "maybe"
								? `up to ${formatCount(l.expected)}`
								: formatCount(l.expected || l.left)}
						</span>{" "}
						× {l.sku ?? l.title}
						{l.sku && <span className="text-muted-foreground"> {l.title}</span>}
					</li>
				))}
				{request && (request.reason || request.trackingNumber) && (
					<li className="truncate text-xs text-muted-foreground">
						{request.reason && returnReason(request.reason)}
						{request.reason && request.trackingNumber && " · "}
						{request.trackingNumber &&
							`${request.carrier ? `${request.carrier} ` : ""}${request.trackingNumber}`}
					</li>
				)}
				{o.unmatched.map((u, i) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: two requests can name the same SKU
						key={i}
						className="truncate text-xs text-warning-text"
					>
						{formatCount(u.quantity)} × {u.sku ?? "an item"}, line unclear
					</li>
				))}
				{o.blocker && (
					<li className="text-xs text-warning-text">{o.blocker}</li>
				)}
			</ul>
			<div className="flex shrink-0 items-center gap-2">
				{state ? (
					<Badge tone={state.tone}>{state.label}</Badge>
				) : (
					<Badge>Not expected</Badge>
				)}
				{onNothing && (
					<Tip content="Nothing coming back (n)">
						<button
							type="button"
							aria-label="Nothing coming back"
							onClick={(e) => {
								e.stopPropagation();
								onNothing();
							}}
							className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-strong hover:text-foreground"
						>
							<Ban className="size-4" />
						</button>
					</Tip>
				)}
			</div>
		</div>
	);
}
