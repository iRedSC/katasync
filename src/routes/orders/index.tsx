import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { PackageCheck, Printer, SearchX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilterPicker, SortMenu, ValueList } from "#/components/filter-menu";
import { FilterSearch } from "#/components/filter-search";
import { LiveSync } from "#/components/live-sync";
import { MatchDialog } from "#/components/match-picker";
import { OrderTabs } from "#/components/order-tabs";
import { OrderTable, orderLink } from "#/components/orders-list/order-table";
import {
	printPlan,
	type Ticks,
	toggle,
	toggleAll,
} from "#/components/orders-list/selection";
import { Card, EmptyState, Page } from "#/components/page";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { useRowLink } from "#/lib/row-link";
import {
	chipsFromUrl,
	facetCounts,
	facetsOf,
	matches,
	ORDER_SORTS,
	type OrderFilter,
	type OrderSortKey,
	orderLanguage,
	parseQuery,
	STATUS_DETAILS,
	sortValuesOf,
} from "#/orders/search";
import {
	isColumn,
	parseSort,
	type Sort,
	sortRows,
	spellSort,
	withTerm,
} from "#/products/sort";
import { listOrders } from "#/server/orders";

type View = "ship" | "all";

// The URL holds the chips, sort, and typed search, so opening an order and
// coming back keeps them. Anything malformed is dropped.
type Search = { view?: View; f?: OrderFilter[]; sort?: string; q?: string };

export const Route = createFileRoute("/orders/")({
	validateSearch: (search: Record<string, unknown>): Search => {
		const f = chipsFromUrl(search.f);
		const sort = spellSort(parseSort(String(search.sort ?? ""), ORDER_SORTS));
		// The URL parser turns "?q=12" into a number, so take it back.
		const q = typeof search.q === "number" ? String(search.q) : search.q;
		return {
			...(search.view === "all" ? { view: "all" } : {}),
			...(f.length ? { f } : {}),
			...(sort ? { sort } : {}),
			...(typeof q === "string" && q !== "" ? { q } : {}),
		};
	},
	loaderDeps: ({ search }) => ({ view: search.view ?? "ship" }),
	loader: ({ deps }) => listOrders({ data: { view: deps.view } }),
	component: Orders,
	pendingComponent: () => (
		<ListSkeleton title="Orders" width="wide">
			<ListCard tabs />
		</ListSkeleton>
	),
});

const FIELD_MENU = [
	{ key: "marketplace", label: "Marketplace", typed: "$" },
	{ key: "status", label: "Status", typed: "%" },
] as const;

function Orders() {
	const { orders: rows, total } = Route.useLoaderData();
	// The server sends only the newest rows; search covers just those.
	const truncated = rows.length < total;
	const search = Route.useSearch();
	const view = search.view ?? "ship";
	const navigate = useNavigate({ from: Route.fullPath });
	const router = useRouter();
	const { link, preload, load } = useRowLink();
	const list = useRef<HTMLTableSectionElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const [cursor, setCursor] = useState(0);
	const [ticks, setTicks] = useState<Ticks>(() => new Set());
	// The last row ticked by hand, where a shift-click's range starts.
	const [anchor, setAnchor] = useState<number | null>(null);
	const [matchingId, setMatchingId] = useState<number | null>(null);
	const closeMatch = useCallback(() => setMatchingId(null), []);

	// The router hands back a new array on every render, so key by content.
	const chipsKey = JSON.stringify(search.f ?? []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content on purpose
	const chips = useMemo(() => search.f ?? [], [chipsKey]);
	const sortText = search.sort ?? "";
	const sort = useMemo(() => parseSort(sortText, ORDER_SORTS), [sortText]);
	// The box answers keystrokes from here; the URL keeps a copy. A tab click,
	// back, or forward moves the URL under the box, so the box follows. Its own
	// typing is a replace, which doesn't, since the URL there is its copy.
	const [query, setText] = useState(search.q ?? "");
	const urlMoved = useRef(false);
	useEffect(
		() =>
			router.history.subscribe(({ action }) => {
				urlMoved.current = action.type !== "REPLACE";
			}),
		[router],
	);
	useEffect(() => {
		if (!urlMoved.current) return;
		urlMoved.current = false;
		setText(search.q ?? "");
	}, [search.q]);

	function setSearch(next: {
		f?: OrderFilter[];
		sort?: Sort<OrderSortKey>;
		q?: string;
	}) {
		navigate({
			search: (prev) => ({
				...prev,
				...("f" in next ? { f: next.f?.length ? next.f : undefined } : {}),
				...(next.sort ? { sort: spellSort(next.sort) || undefined } : {}),
				...("q" in next ? { q: next.q || undefined } : {}),
			}),
			replace: true,
			resetScroll: false,
		});
	}
	function setQuery(text: string) {
		setText(text);
		setSearch({ q: text });
	}

	const facets = useMemo(() => rows.map(facetsOf), [rows]);
	const counts = useMemo(() => facetCounts(facets), [facets]);
	const language = useMemo(() => orderLanguage(counts), [counts]);
	const q = useMemo(() => parseQuery(query), [query]);
	const filtering =
		chips.length > 0 || q.filters.some((f) => f.value) || q.words.length > 0;
	const shown = useMemo(() => {
		const all = [...chips, ...q.filters];
		// A sort still being typed applies once it names a column exactly.
		const by = q.sorts.reduce<Sort<OrderSortKey>>(
			(s, t) =>
				isColumn(t.value, ORDER_SORTS)
					? withTerm(s, { key: t.value, desc: t.desc })
					: s,
			sort,
		);
		return sortRows(
			rows.filter((_, i) => matches(facets[i], all, q.words)),
			by,
			sortValuesOf,
		);
	}, [rows, facets, chips, q, sort]);
	const plan = printPlan({ view, ticks, shown, filtering });

	// Printing happens in another tab and marks the orders printed there, so
	// once one is opened, each return to this tab reloads the list to show
	// it. Every return, since the print dialog may still be open the first.
	const [printOpened, setPrintOpened] = useState(false);
	useEffect(() => {
		if (!printOpened) return;
		const back = () => {
			if (document.visibilityState === "visible") router.invalidate();
		};
		document.addEventListener("visibilitychange", back);
		return () => document.removeEventListener("visibilitychange", back);
	}, [printOpened, router]);

	// A new tab starts over: ticks from the other list don't carry across. The
	// typed search goes too, since the tabs drop it from the URL the box follows.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resets when the view changes
	useEffect(() => {
		setTicks(new Set());
		setAnchor(null);
	}, [view]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: resets when what's shown changes
	useEffect(() => setCursor(0), [view, chipsKey, query, sortText]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: follows the cursor, not each reload of the rows
	useEffect(() => {
		list.current
			?.querySelector(`[data-index="${cursor}"]`)
			?.scrollIntoView({ block: "nearest" });
		// Enter opens the row under the cursor, so it's loaded ahead too.
		const o = shown[cursor];
		if (o) preload(orderLink(o));
	}, [cursor, preload]);

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
				const o = shown[Number((e.target as HTMLElement).dataset.index)];
				if (o) load(orderLink(o));
			}
		});
		for (const tr of body.querySelectorAll("tr[data-index]")) seen.observe(tr);
		return () => seen.disconnect();
	}, [view, shown.map((o) => o.id).join(), load]);

	function tick(i: number, range: boolean) {
		setTicks((t) => toggle(t, shown, i, anchor, range));
		setAnchor(i);
	}

	useHotkeys({
		j: () => setCursor((i) => Math.min(i + 1, shown.length - 1)),
		k: () => setCursor((i) => Math.max(i - 1, 0)),
		x: () => tick(cursor, false),
		Enter: () => {
			const o = shown[cursor];
			if (o) navigate(orderLink(o));
		},
		"/": () => input.current?.focus(),
		Escape: () => {
			if (document.activeElement === input.current) input.current?.blur();
			else if (plan?.kind === "ids" && plan.why === "ticked")
				setTicks(new Set());
			else if (query) setQuery("");
		},
	});

	return (
		<Page
			title="Orders"
			width="wide"
			actions={
				<>
					<LiveSync repeat />
					{plan && (
						<PrintButton plan={plan} onOpen={() => setPrintOpened(true)} />
					)}
				</>
			}
		>
			<Card flush className="overflow-visible">
				<OrderTabs active={view} count={total} />
				<div className="flex items-start gap-1 border-b p-2">
					<div className="min-w-0 flex-1">
						<FilterSearch
							inputRef={input}
							text={query}
							onText={setQuery}
							chips={chips}
							onChips={(f) => setSearch({ f })}
							language={language}
							sort={sort}
							onSort={(s) => setSearch({ sort: s })}
							columns={ORDER_SORTS}
							placeholder="Search, or $tiktok %unfulfilled ^total"
						/>
					</div>
					<FilterPicker<OrderFilter>
						fields={FIELD_MENU.map((f) => ({
							...f,
							body: (add) => (
								<ValueList
									values={counts.get(f.key) ?? new Map()}
									details={f.key === "status" ? STATUS_DETAILS : undefined}
									onAdd={(value, exclude) =>
										add({ field: f.key, value, exclude, exact: true })
									}
								/>
							),
						}))}
						onAdd={(f) => setSearch({ f: [...chips, f] })}
					/>
					<SortMenu
						sort={sort}
						onSort={(s) => setSearch({ sort: s })}
						columns={ORDER_SORTS}
					/>
				</div>
				{truncated && (
					<p className="border-b px-4 py-1.5 text-xs text-muted-foreground tabular-nums">
						Showing the newest {formatCount(rows.length)} of{" "}
						{formatCount(total)}, so search can't reach the rest
					</p>
				)}
				{filtering && rows.length > 0 && (
					<p className="border-b px-4 py-1.5 text-xs text-muted-foreground tabular-nums">
						{formatCount(shown.length)} of {formatCount(rows.length)} orders
					</p>
				)}

				{rows.length === 0 ? (
					<EmptyState
						icon={PackageCheck}
						title={view === "ship" ? "Nothing to ship" : "No orders"}
					/>
				) : shown.length === 0 ? (
					<EmptyState
						icon={SearchX}
						title={truncated ? "No loaded orders match" : "No orders match"}
					>
						<button
							type="button"
							onClick={() => {
								setText("");
								setSearch({ f: [], q: "" });
							}}
							className="text-link hover:underline"
						>
							Clear the search
						</button>
					</EmptyState>
				) : (
					<OrderTable
						rows={shown}
						view={view}
						bodyRef={list}
						cursor={cursor}
						onCursor={setCursor}
						ticks={ticks}
						onTick={tick}
						onTickAll={() => setTicks((t) => toggleAll(t, shown))}
						link={link}
						onMatch={setMatchingId}
					/>
				)}
			</Card>
			<MatchDialog orderId={matchingId} onClose={closeMatch} />
		</Page>
	);
}

// Says how many it prints, so a filtered list never prints more than it
// shows, and what it skips, so a printed order isn't silently missing.
function PrintButton({
	plan,
	onOpen,
}: {
	plan: NonNullable<ReturnType<typeof printPlan>>;
	onOpen: () => void;
}) {
	if (plan.kind === "done") {
		return (
			<Tip content="Every order here is printed. Tick one to print it again">
				<Button variant="outline" size="sm" disabled>
					<Printer />
					All printed
				</Button>
			</Tip>
		);
	}
	const label =
		plan.kind === "all"
			? plan.skipped > 0
				? "Print all new"
				: "Print all"
			: plan.why === "ticked"
				? `Print ${formatCount(plan.ids.length)} ticked`
				: `Print ${formatCount(plan.ids.length)} ${plan.skipped > 0 ? "new" : "shown"}`;
	const notes = [
		plan.kind === "ids" && plan.leftOut > 0
			? `Leaves out ${formatCount(plan.leftOut)} cancelled with a label to void`
			: null,
		plan.kind !== "ids" || plan.why === "shown"
			? plan.skipped > 0
				? `Skips ${formatCount(plan.skipped)} already printed. Tick one to print it again`
				: null
			: null,
	].filter((n) => n !== null);
	const button = (
		<Button asChild variant="outline" size="sm">
			<Link
				to="/print/invoices"
				search={plan.kind === "ids" ? { ids: plan.ids } : {}}
				target="_blank"
				rel="noreferrer"
				onClick={onOpen}
			>
				<Printer />
				{label}
			</Link>
		</Button>
	);
	return notes.length > 0 ? (
		<Tip content={notes.join(". ")}>{button}</Tip>
	) : (
		button
	);
}
