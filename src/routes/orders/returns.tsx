import { createFileRoute } from "@tanstack/react-router";
import {
	ChevronRight,
	ExternalLink,
	Printer,
	ScanBarcode,
	Search,
	SearchX,
	Undo2,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FilterBar, useSearchRows } from "#/components/filter-bar";
import { conditionName } from "#/components/order-page/return-card";
import { OrderTabs, ReturnsViews } from "#/components/order-tabs";
import { Badge, Card, EmptyState, Page } from "#/components/page";
import {
	type Outcome,
	type Received,
	ReturnDialog,
} from "#/components/return-dialog";
import { CaseGroups } from "#/components/returns/case-groups";
import { GROUPS } from "#/components/returns/return-cells";
import { ICON_BUTTON, ReturnRow } from "#/components/returns/return-row";
import {
	NothingDue,
	ReturnsChecked,
} from "#/components/returns/returns-checked";
import { ScanLabel } from "#/components/returns/scan-label";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { type Chip, defineSearch } from "#/lib/facet-search";
import { formatCount, formatOrderDate } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism, optimistic, type Patch } from "#/lib/optimism";
import { useRowLink } from "#/lib/row-link";
import { offerUndo } from "#/lib/undo";
import { NEXT_ORDER, ours, returnSituation } from "#/orders/return-situation";
import type { ReturnOrder } from "#/orders/returns-due";
import { marketplaceOf } from "#/orders/search";
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

const OUTCOME = {
	restock: "restocked",
	refurbish: "refurbished",
	write_off: "written_off",
} as const;

// Receiving takes what came back off what's expected and counts it back
// here; with nothing left expected (or a maybe, once anything is back) its
// situation moves on: to refund or close while its marketplace has it open,
// or off the list. Undo shows it again when the page reloads.
const receivedPatch = (
	orderId: number,
	received: Received[],
	outcome: Outcome,
): Patch =>
	returnsData.patch("all", (d) => ({
		...d,
		returns: d.returns.map((o) => {
			if (o.id !== orderId) return o;
			const lines = o.lines.map((l) => {
				const n = received.find((r) => r.lineId === l.id)?.quantity ?? 0;
				return {
					...l,
					left: l.left - n,
					// What's left first, as receiving takes them.
					counted: Math.max(
						0,
						l.counted - Math.max(0, n - (l.left - l.counted)),
					),
					expected: Math.max(0, l.expected - n),
				};
			});
			const got = received.reduce((n, r) => n + r.quantity, 0);
			return {
				...o,
				lines,
				state:
					o.state === "maybe" || !lines.some((l) => l.expected > 0)
						? null
						: o.state,
				back: {
					quantity: (o.back?.quantity ?? 0) + got,
					at: new Date(),
					outcome: OUTCOME[outcome],
				},
			};
		}),
	}));

const dismissedPatch = (orderId: number): Patch =>
	returnsData.patch("all", (d) => ({
		...d,
		returns: d.returns.map((o) =>
			o.id === orderId ? { ...o, state: null, noReturnAt: new Date() } : o,
		),
	}));

type ReceivedRow = ReturnsData["received"][number];

const unreceivedPatch = (id: number): Patch =>
	returnsData.patch("all", (d) => ({
		...d,
		received: d.received.filter((r) => r.id !== id),
	}));

// Nothing to lay over: the reload shows the order again.
const reloadOnly = returnsData.patch("all", (d) => d);

// What's on the box finds the order: its number, buyer, where it went,
// what was in it, and the return's tracking.
const returnSearch = defineSearch<
	ReturnOrder,
	"state" | "marketplace" | "placed"
>({
	fields: {
		state: {
			kind: "values",
			sigil: "%",
			label: "status",
			menu: "Status",
			words: ["status"],
			of: (o) => {
				const next = returnSituation(o).next.kind;
				return next === "done" ? null : GROUPS[next].label;
			},
			known: Object.values(GROUPS).map((g) => g.label),
			closed: true,
		},
		marketplace: {
			kind: "values",
			sigil: "$",
			label: "sold on",
			menu: "Marketplace",
			words: ["marketplace", "channel", "sold"],
			of: marketplaceOf,
		},
		placed: {
			kind: "period",
			sigil: "~",
			label: "placed",
			menu: "Placed",
			words: ["placed", "date", "when"],
			at: (o) => o.placedAt,
		},
	},
	text: (o) => [
		o.name,
		o.externalId,
		o.marketplaceOrderId,
		o.customerName,
		o.shipCity,
		o.shipPostalCode,
		...o.lines.flatMap((l) => [l.sku, l.title]),
		...o.requests.map((r) => r.trackingNumber),
		...o.unmatched.map((u) => u.sku),
	],
});

// The search for orders not due back: the query it answers, and what came back.
type OtherSearch =
	| { q: string; state: "done"; rows: ReturnOrder[] }
	| { q: string; state: "failed" };

function Returns() {
	const loaded = Route.useLoaderData();
	const { cases, returns, received, checked } = returnsData.useData(
		"all",
		loaded,
	);
	const [closeOpen, setCloseOpen] = useState(false);
	const { link } = useRowLink();
	const input = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [chips, setChips] = useState<
		Chip<"state" | "marketplace" | "placed">[]
	>([]);
	const [others, setOthers] = useState<OtherSearch | null>(null);
	const [receiving, setReceiving] = useState<ReturnOrder | null>(null);
	// Scanning box after box: the scanner opens again once each is checked in.
	const [scanning, setScanning] = useState<"off" | "on" | "paused">("off");

	const { idx, shown, words } = useSearchRows(
		returnSearch,
		returns,
		chips,
		query,
	);
	// Orders that can take a return but aren't expected to, for a box that
	// turns up first, found by the words typed. Asked for once typing pauses.
	// Chips narrow what's due, which these aren't.
	const wordsTyped = chips.length === 0 ? words.join(" ") : "";
	useEffect(() => {
		const q = wordsTyped;
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
	}, [wordsTyped]);
	const found =
		wordsTyped.length >= 3 && others?.q === wordsTyped ? others : null;
	const listed = new Set(returns.map((o) => o.id));
	const extra =
		found?.state === "done" ? found.rows.filter((o) => !listed.has(o.id)) : [];
	const extraFailed = found?.state === "failed";
	const rows = [...shown, ...extra];

	// The one order a search has narrowed to, which Enter receives: a box
	// scanned or typed in goes straight to its dialog, and a search that
	// still matches several receives nothing until it's narrowed.
	const only = rows.length === 1 ? rows[0] : undefined;

	function receive(o: ReturnOrder | undefined) {
		if (!o) return false;
		if (o.blocker) {
			toast.error(`Can't receive ${o.name} here`, { description: o.blocker });
			return false;
		}
		if (o.lines.length === 0) {
			toast.error(`${o.name} is all back already`);
			return false;
		}
		setReceiving(o);
		return true;
	}

	function scanned(o: ReturnOrder) {
		// The list's copy knows what's expected; a scan's may be older.
		if (receive(returns.find((r) => r.id === o.id) ?? o)) setScanning("paused");
	}

	async function nothingComing(o: ReturnOrder | undefined) {
		if (!o?.state) return;
		const wasRefunded = o.state === "refunded";
		const r = await optimism.change({
			label: `Nothing coming back on ${o.name}`,
			patch: dismissedPatch(o.id),
			send: () => markOrderNoReturn({ data: { orderId: o.id } }),
		});
		if (!r) return;
		offerUndo(`Nothing coming back on ${o.name}`, {
			description: wasRefunded
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
			else if (chips.length) setChips([]);
		},
	});

	const situations = useMemo(
		() => new Map(returns.map((o) => [o.id, returnSituation(o)])),
		[returns],
	);
	const situationOf = (o: ReturnOrder) =>
		situations.get(o.id) ?? returnSituation(o);
	const row = (o: ReturnOrder) => (
		<ReturnRow
			key={o.id}
			order={o}
			situation={situationOf(o)}
			onReceive={() => receive(o)}
			onNothing={o.state ? () => nothingComing(o) : undefined}
			link={link}
		/>
	);
	// Refunds with nothing coming back and marketplace cases are answered
	// on their own, above the returns.
	const asking = !query.trim() && chips.length === 0 ? cases : [];
	// Back here and not refunded is the Refunds view's.
	const groups = NEXT_ORDER.flatMap((next) =>
		next === "done" || next === "refund"
			? []
			: [
					{
						next,
						orders: shown.filter((o) => situationOf(o).next.kind === next),
					},
				],
	).filter((g) => g.orders.length > 0);
	// What's ours to do: the tab's count.
	const toDo =
		new Set(
			cases
				.filter((c) => c.waitingOn === "us")
				.map((c) => c.orderId ?? `case:${c.id}`),
		).size +
		returns.filter((o) => {
			const next = situationOf(o).next;
			return ours(next) && next.kind !== "refund";
		}).length;
	const listedRows = groups.reduce((n, g) => n + g.orders.length, 0);

	return (
		<Page title="Orders" width="wide">
			<Card flush className="overflow-visible">
				<OrderTabs
					active="returns"
					count={toDo}
					aside={
						<>
							<ReturnsChecked checks={checked} />
							<ReturnsViews active="due" />
						</>
					}
				/>
				<div className="flex items-center gap-2 border-b p-2">
					<Button onClick={() => setScanning("on")} className="shrink-0">
						<ScanBarcode />
						Scan label
					</Button>
					<FilterBar
						search={returnSearch}
						idx={idx}
						inputRef={input}
						text={query}
						onText={setQuery}
						chips={chips}
						onChips={setChips}
						onSubmit={() => receive(only)}
						placeholder="What's on the box: order number, name, zip, SKU, tracking, or %arrived"
						className="min-w-0 flex-1"
					/>
				</div>

				{extraFailed && listedRows + extra.length === 0 ? (
					<EmptyState icon={Search} title="Search didn't finish">
						Type to search again.
					</EmptyState>
				) : listedRows + extra.length === 0 && asking.length === 0 ? (
					query.trim() || chips.length ? (
						<EmptyState icon={SearchX} title="No order matches">
							{chips.length
								? null
								: wordsTyped.length < 3
									? "Type a few more letters to search every order."
									: "Try the buyer's name, a SKU, or the zip on the label."}
						</EmptyState>
					) : (
						<NothingDue checks={checked} />
					)
				) : (
					<table className="w-full whitespace-nowrap">
						<thead>
							<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
								<th className="px-4 py-2 font-medium">Order</th>
								<th className="hidden px-4 py-2 font-medium md:table-cell">
									Customer
								</th>
								<th className="px-4 py-2 font-medium">Items</th>
								<th className="px-4 py-2 font-medium">Item</th>
								<th className="hidden px-4 py-2 font-medium sm:table-cell">
									Refund
								</th>
								<th className="w-0 px-2 py-2" />
							</tr>
						</thead>
						<tbody>
							<CaseGroups cases={asking} link={link} />
							{groups.map((g) => {
								// Close folds away: the marketplace closes most on its own.
								const folds = g.next === "close" && !query.trim();
								const open = !folds || closeOpen;
								return (
									<Fragment key={g.next}>
										<GroupHeading
											dot={GROUPS[g.next].dot}
											onToggle={
												folds ? () => setCloseOpen((o) => !o) : undefined
											}
											open={open}
										>
											{GROUPS[g.next].heading}
											<span className="ml-1.5 tabular-nums">
												{formatCount(g.orders.length)}
											</span>
										</GroupHeading>
										{open && g.orders.map(row)}
									</Fragment>
								);
							})}
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

			{received.length > 0 && !query.trim() && chips.length === 0 && (
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

			<ScanLabel
				open={scanning === "on"}
				onOpenChange={(open) => setScanning(open ? "on" : "off")}
				onFound={scanned}
			/>

			{receiving && (
				<ReturnDialog
					key={receiving.id}
					open
					onOpenChange={(open) => {
						if (open) return;
						setReceiving(null);
						if (scanning === "paused") setScanning("on");
					}}
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
						receive: (got, outcome) => {
							setQuery("");
							setOthers(null);
							return receivedPatch(receiving.id, got, outcome);
						},
						undo: () => reloadOnly,
					}}
				/>
			)}
		</Page>
	);
}

const COLUMNS = 6;

function GroupHeading({
	children,
	dot,
	onToggle,
	open = true,
}: {
	children: React.ReactNode;
	dot?: string;
	onToggle?: () => void;
	open?: boolean;
}) {
	return (
		<tr
			onClick={onToggle}
			className={onToggle ? "cursor-pointer select-none" : undefined}
		>
			<td
				colSpan={COLUMNS}
				className="border-y bg-subtle px-4 py-1.5 text-xs font-medium text-muted-foreground"
			>
				<span className="flex items-center gap-2">
					{onToggle && (
						<ChevronRight
							className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
						/>
					)}
					{dot && <span className={`size-2 rounded-full ${dot}`} />}
					<span>{children}</span>
				</span>
			</td>
		</tr>
	);
}
