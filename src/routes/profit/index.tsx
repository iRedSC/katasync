import { createFileRoute, Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	ArrowDown,
	ArrowUp,
	Receipt,
	Search,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChannelBadge } from "#/components/channel-badge";
import { MatchDialog } from "#/components/match-picker";
import { Card, EmptyState, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import {
	PROFIT_DEFAULTS,
	ProfitViews,
	RangeTabs,
	rangeSearch,
} from "#/components/profit-nav";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import {
	channelName,
	formatCount,
	formatMoney,
	formatOrderDate,
} from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { ITEMS_LIMIT } from "#/orders/profit";
import { getProfitItems, setProductCost } from "#/server/profit";

// Every item sold in a stretch of time and what it made: its sales less its
// cost, less its share of its order's fees, labels, refunds and adjustments
// (order_line_profit). A product with no cost can be given one right here.

const VIEW = "/profit";
const DEFAULT = PROFIT_DEFAULTS[VIEW];

export const Route = createFileRoute("/profit/")({
	validateSearch: rangeSearch(VIEW),
	loaderDeps: ({ search }) => ({ range: search.range ?? DEFAULT }),
	loader: ({ deps }) => getProfitItems({ data: { range: deps.range } }),
	component: Items,
	pendingComponent: () => (
		<ListSkeleton title="Profit">
			<ListCard rows={12} picture />
		</ListSkeleton>
	),
});

type Item = Awaited<ReturnType<typeof getProfitItems>>["items"][number];

const itemsData = optimistic<Item[]>("profit-items");

const margin = (i: Pick<Item, "profit" | "revenue">) =>
	i.revenue === 0 ? null : i.profit / i.revenue;
const percent = (value: number | null) =>
	value === null ? "—" : `${(value * 100).toFixed(1)}%`;
// What the label cost less what the buyer paid for shipping.
const shipping = (i: Item) => i.labels - i.shippingCharged;
const other = (i: Item) => i.refunds + i.adjustments;

// Made money, but so little a small surprise turns it into a loss.
const THIN_MARGIN = 0.05;
const THIN_PROFIT = 3;
const isThin = (i: Item) =>
	i.profit >= 0 && (i.profit < THIN_PROFIT || (margin(i) ?? 0) < THIN_MARGIN);
// Made enough on one sale to stand out.
const GREAT_PROFIT = 100;

// How a sale did, at a glance: its row's color. A sale with no cost has a
// profit that's too high, so it gets no verdict.
const VERDICT = {
	loss: { row: "bg-critical-surface", text: "text-critical-text" },
	thin: { row: "bg-warning-surface", text: "text-warning-text" },
	great: { row: "bg-success-surface/50", text: "text-success-text" },
} as const;
function verdict(i: Item): keyof typeof VERDICT | null {
	if (!i.costKnown) return null;
	if (i.profit < 0) return "loss";
	if (isThin(i)) return "thin";
	if (i.profit >= GREAT_PROFIT) return "great";
	return null;
}

// The profit gauge's scale squeezes as it grows, so every row shares it: the
// first $10 takes a real step, and $300 either way reaches the end. A sale past
// that stops at the edge with a mark.
const GAUGE_STEP = 10;
const GAUGE_END = 300;
// Where a profit sits from -1 (the left end) to 1 (the right).
const gauge = (profit: number) =>
	Math.sign(profit) *
	Math.min(
		1,
		Math.log1p(Math.abs(profit) / GAUGE_STEP) /
			Math.log1p(GAUGE_END / GAUGE_STEP),
	);

// Why an item's profit isn't final yet, in words.
function unsure(i: Item): string[] {
	const sold = channelName(i.soldOn);
	return [
		!i.costKnown &&
			(i.productId === null
				? "Not linked to a product, so it has no cost"
				: "No product cost, so its profit is too high"),
		i.feesStatus === "estimated" &&
			`Fees are an estimate until ${sold} reports them`,
		i.labelsStatus === "awaiting" &&
			`Shipped; waiting for ${sold} to bill any label`,
		i.labelsStatus === "missing" &&
			"Shipped, but no label cost from anyone, so its profit is too high",
		i.labelsStatus === "stand_in" &&
			"The label cost is an estimate until it's billed",
		i.returning > 0 &&
			`Refunded; ${formatCount(i.returning)} not back yet, so ${i.returning === 1 ? "its" : "their"} cost isn't counted until written off or 60 days pass`,
	].filter((n): n is string => typeof n === "string");
}

type Show = "loss" | "thin" | "no_cost" | "unsure";
const SHOWS: [Show, string, (i: Item) => boolean][] = [
	["loss", "Lost money", (i) => i.profit < 0],
	["thin", "Thin margin", isThin],
	["no_cost", "No cost", (i) => !i.costKnown],
	["unsure", "Not final", (i) => !i.complete],
];

type SortKey =
	| "date"
	| "revenue"
	| "cost"
	| "fees"
	| "shipping"
	| "other"
	| "profit"
	| "margin";
const SORT_VALUE: Record<SortKey, (i: Item) => number | null> = {
	date: (i) => new Date(i.placedAt).getTime(),
	revenue: (i) => i.revenue,
	cost: (i) => (i.costKnown ? i.cost : null),
	fees: (i) => i.fees,
	shipping,
	other,
	profit: (i) => i.profit,
	margin,
};

const PAGE = 200;

function Items() {
	const loaded = Route.useLoaderData();
	const { range = DEFAULT } = Route.useSearch();
	const items = itemsData.useData(range, loaded.items);
	const [text, setText] = useState("");
	const [shows, setShows] = useState<Set<Show>>(new Set());
	const [channels, setChannels] = useState<Set<string>>(new Set());
	const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
		key: "date",
		desc: true,
	});
	const [limit, setLimit] = useState(PAGE);

	const soldOn = useMemo(
		() => [...new Set(items.map((i) => i.soldOn))].sort(),
		[items],
	);

	const shown = useMemo(() => {
		const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const tests = SHOWS.filter(([key]) => shows.has(key)).map(([, , t]) => t);
		const value = SORT_VALUE[sort.key];
		return items
			.filter(
				(i) =>
					(channels.size === 0 || channels.has(i.soldOn)) &&
					tests.every((t) => t(i)) &&
					words.every((w) =>
						[i.sku, i.name, i.variantName, i.orderName].some((f) =>
							f?.toLowerCase().includes(w),
						),
					),
			)
			.sort((a, b) => {
				// Unknowns last either way.
				const x = value(a);
				const y = value(b);
				if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
				return sort.desc ? y - x : x - y;
			});
	}, [items, text, shows, channels, sort]);

	const toggle = <T,>(set: Set<T>, value: T) => {
		const next = new Set(set);
		if (!next.delete(value)) next.add(value);
		return next;
	};
	const sortBy = (key: SortKey) =>
		setSort((s) =>
			s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "date" },
		);

	return (
		<Page
			title="Profit"
			width="wide"
			actions={<ProfitViews view={VIEW} range={range} />}
		>
			<RangeTabs view={VIEW} range={range} />
			{loaded.unshipped > 0 && (
				<p className="text-muted-foreground">
					{formatCount(loaded.unshipped)} more{" "}
					{loaded.unshipped === 1 ? "item waits" : "items wait"} for payment or
					shipping and will show once{" "}
					{loaded.unshipped === 1 ? "it ships" : "they ship"}.
				</p>
			)}
			{items.length === 0 ? (
				<EmptyState icon={Receipt} title="Nothing shipped in this range" />
			) : (
				<>
					<Summary items={shown} cut={loaded.cut} />
					<Card flush>
						<div className="flex flex-wrap items-center gap-2 border-b p-2">
							<label className="flex h-8 min-w-56 flex-1 items-center gap-2 rounded-lg border border-input px-2.5 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
								<Search className="size-4 text-muted-foreground" />
								<input
									value={text}
									onChange={(e) => {
										setText(e.target.value);
										setLimit(PAGE);
									}}
									placeholder="SKU, name, or order"
									className="min-w-0 flex-1 bg-transparent outline-none"
								/>
							</label>
							{soldOn.length > 1 &&
								soldOn.map((c) => (
									<Chip
										key={c}
										on={channels.has(c)}
										onClick={() => {
											setChannels(toggle(channels, c));
											setLimit(PAGE);
										}}
									>
										{channelName(c)}
									</Chip>
								))}
							{SHOWS.map(([key, label, test]) => (
								<Chip
									key={key}
									on={shows.has(key)}
									onClick={() => {
										setShows(toggle(shows, key));
										setLimit(PAGE);
									}}
								>
									{label}
									<span className="ml-1.5 text-muted-foreground tabular-nums">
										{formatCount(items.filter(test).length)}
									</span>
								</Chip>
							))}
						</div>
						{shown.length === 0 ? (
							<p className="p-6 text-center text-muted-foreground">
								No items match.
							</p>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full whitespace-nowrap tabular-nums">
									<thead>
										<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
											<Th sort={sort} by="date" onSort={sortBy}>
												Order
											</Th>
											<th className="w-full px-2.5 py-2 font-medium">Item</th>
											<Th sort={sort} by="revenue" onSort={sortBy} right>
												Sales
											</Th>
											<Th sort={sort} by="cost" onSort={sortBy} right>
												Cost
											</Th>
											<Th sort={sort} by="fees" onSort={sortBy} right>
												Fees
											</Th>
											<Th sort={sort} by="shipping" onSort={sortBy} right>
												Shipping
											</Th>
											<Th sort={sort} by="other" onSort={sortBy} right>
												Refunds
											</Th>
											<Th
												sort={sort}
												by="profit"
												onSort={sortBy}
												right
												also={["margin", "Margin"]}
											>
												Profit
											</Th>
											<th className="px-2.5 py-2 font-medium">
												<span className="sr-only">Profit at a glance</span>
											</th>
										</tr>
									</thead>
									<tbody>
										{shown.slice(0, limit).map((i) => (
											<Row key={i.lineId} item={i} range={range} />
										))}
									</tbody>
								</table>
							</div>
						)}
						{shown.length > limit ? (
							<div className="border-t p-2 text-center">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setLimit((l) => l + PAGE)}
								>
									Show more ({formatCount(shown.length - limit)} left)
								</Button>
							</div>
						) : (
							loaded.cut && (
								<p className="border-t p-3 text-center text-muted-foreground">
									Older items in this range aren't loaded. Pick a shorter range
									to see them.
								</p>
							)
						)}
					</Card>
				</>
			)}
		</Page>
	);
}

// Totals of what's shown, so a filter answers "how much did these make".
// When the range holds more items than load, these totals are only the
// newest ones, and the card says so rather than passing for the whole range.
function Summary({ items, cut }: { items: Item[]; cut: boolean }) {
	const sum = (f: (i: Item) => number) =>
		items.reduce((total, i) => total + f(i), 0);
	const profit = sum((i) => i.profit);
	const revenue = sum((i) => i.revenue);
	const losses = items.filter((i) => i.profit < 0);
	const stats: [string, string, boolean?][] = [
		["Profit", formatMoney(profit), profit < 0],
		["Margin", percent(margin({ profit, revenue }))],
		["Sales", formatMoney(revenue)],
		["Items sold", formatCount(sum((i) => i.quantity))],
		[
			"Lost money",
			`${formatCount(losses.length)} · ${formatMoney(sum((i) => Math.min(0, i.profit)))}`,
			losses.length > 0,
		],
	];
	return (
		<Card flush>
			<dl className="grid grid-cols-2 md:grid-cols-5 md:divide-x">
				{stats.map(([label, value, bad]) => (
					<div key={label} className="flex flex-col gap-1 p-4">
						<dt className="text-muted-foreground">{label}</dt>
						<dd
							className={cn(
								"text-xl font-bold tabular-nums",
								bad && "text-critical-text",
							)}
						>
							{value}
						</dd>
					</div>
				))}
			</dl>
			{cut && (
				<p className="flex items-center gap-2 border-t px-4 py-2 text-warning-text">
					<AlertTriangle className="size-4 shrink-0 text-warning-icon" />
					Totals of the newest {formatCount(ITEMS_LIMIT)} items only. A shorter
					range totals them all; the overview covers every order.
				</p>
			)}
		</Card>
	);
}

function Chip({
	on,
	onClick,
	children,
}: {
	on: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			onClick={onClick}
			className={cn(
				"inline-flex h-8 items-center rounded-lg border px-2.5 font-medium",
				on
					? "border-ring bg-surface-strong text-foreground"
					: "text-muted-foreground hover:bg-surface hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

// A column to sort by, and maybe a second one shown in the same cell (a
// profit's margin).
function Th({
	sort,
	by,
	onSort,
	right,
	also,
	children,
}: {
	sort: { key: SortKey; desc: boolean };
	by: SortKey;
	onSort: (key: SortKey) => void;
	right?: boolean;
	also?: [SortKey, string];
	children: ReactNode;
}) {
	const Arrow = sort.desc ? ArrowDown : ArrowUp;
	const button = (key: SortKey, label: ReactNode) => (
		<button
			type="button"
			onClick={() => onSort(key)}
			className={cn(
				"inline-flex items-center gap-1 hover:text-foreground",
				sort.key === key && "text-foreground",
			)}
		>
			{label}
			{sort.key === key && <Arrow className="size-3" />}
		</button>
	);
	const sorted = sort.key === by || sort.key === also?.[0];
	return (
		<th
			className={cn("px-2.5 py-2 font-medium", right && "text-right")}
			aria-sort={sorted ? (sort.desc ? "descending" : "ascending") : undefined}
		>
			{button(by, children)}
			{also && (
				<>
					<span className="mx-1">·</span>
					{button(also[0], also[1])}
				</>
			)}
		</th>
	);
}

function Row({ item: i, range }: { item: Item; range: string }) {
	const notes = unsure(i);
	const m = margin(i);
	const v = verdict(i);
	// Without a cost the figure is too high, so it's muted.
	const tone = !i.costKnown ? "text-muted-foreground" : v && VERDICT[v].text;
	return (
		<tr
			className={cn(
				"border-t first:border-t-0",
				v ? cn(VERDICT[v].row, "hover:brightness-[0.97]") : "hover:bg-subtle",
			)}
		>
			<td className="px-2.5 py-2">
				<div className="flex items-center gap-2">
					<ChannelBadge channel={i.soldOn} salesChannel={null} compact />
					<Link
						to="/orders/$id"
						params={{ id: String(i.orderId) }}
						className="font-medium text-link hover:underline"
					>
						{i.orderName}
					</Link>
				</div>
				<div className="mt-0.5 text-xs text-muted-foreground">
					{formatOrderDate(i.placedAt)}
				</div>
			</td>
			{/* Takes the leftover width; long names end in "…". */}
			<td className="max-w-0 min-w-52 px-2.5 py-2">
				<div className="flex items-center gap-2.5">
					<ProductImage src={i.imageUrl} className="size-8" />
					<div className="min-w-0">
						{i.productId !== null && i.sku ? (
							<Link
								to="/products/$sku"
								params={{ sku: i.sku }}
								className="block truncate hover:underline"
							>
								<ProductName name={i.name} variantName={i.variantName} />
							</Link>
						) : (
							<div className="truncate">{i.name}</div>
						)}
						<div className="truncate text-xs text-muted-foreground">
							{i.sku ?? "No SKU"} · {formatCount(i.quantity)} sold
						</div>
					</div>
				</div>
			</td>
			<td className="px-2.5 py-2 text-right">{formatMoney(i.revenue)}</td>
			<td className="px-2.5 py-2 text-right">
				<Cost item={i} range={range} />
			</td>
			<td className="px-2.5 py-2 text-right">
				{formatMoney(i.fees)}
				{i.feesStatus === "estimated" && <Approx />}
			</td>
			<td className="px-2.5 py-2 text-right">
				<Tip
					content={`Labels ${formatMoney(i.labels)}, less ${formatMoney(i.shippingCharged)} the buyer paid for shipping`}
				>
					<span>{formatMoney(shipping(i))}</span>
				</Tip>
			</td>
			<td className="px-2.5 py-2 text-right">
				{other(i) === 0 ? (
					<span className="text-muted-foreground">—</span>
				) : (
					<Tip
						content={`Refunds ${formatMoney(i.refunds)}, other adjustments ${formatMoney(i.adjustments)}`}
					>
						<span>{formatMoney(other(i))}</span>
					</Tip>
				)}
			</td>
			<td className={cn("px-2.5 py-2 text-right", tone)}>
				<span className="font-semibold">{formatMoney(i.profit)}</span>
				{notes.length > 0 && (
					<Tip
						content={
							<ul className="list-disc pl-4">
								{notes.map((n) => (
									<li key={n}>{n}</li>
								))}
							</ul>
						}
					>
						<span className="ml-1 text-warning-text">≈</span>
					</Tip>
				)}
				<div className="text-xs">{percent(m)}</div>
			</td>
			<td className="py-2 pr-4 pl-1.5">
				<Gauge profit={i.profit} unsure={!i.costKnown} />
			</td>
		</tr>
	);
}

// Where a profit falls, at a glance: color fills from the zero line out to a
// pin, red for a loss and green for a gain, so its length is how much.
function Gauge({ profit, unsure }: { profit: number; unsure: boolean }) {
	const at = 50 + gauge(profit) * 50;
	const loss = profit < 0;
	const past = Math.abs(profit) > GAUGE_END;
	return (
		<div
			role="img"
			aria-label={`${loss ? "Lost" : "Made"} ${formatMoney(Math.abs(profit))}`}
			// Without a cost the profit is too high, so the gauge is faded too.
			className={cn("relative h-4 w-28", unsure && "opacity-40")}
		>
			<div className="absolute inset-x-0 top-1.5 h-1 rounded-full bg-black/8" />
			<div
				className={cn(
					"absolute top-1.5 h-1",
					loss
						? "rounded-l-full bg-critical-icon"
						: "rounded-r-full bg-success-icon",
				)}
				style={{ left: `${Math.min(50, at)}%`, width: `${Math.abs(at - 50)}%` }}
			/>
			<div className="absolute inset-y-0.5 left-1/2 w-px bg-black/35" />
			<div
				className={cn(
					"absolute top-0.75 size-2.5 -translate-x-1/2 rounded-full border-2 bg-white shadow-sm",
					loss ? "border-critical-icon" : "border-success-icon",
				)}
				style={{ left: `${at}%` }}
			/>
			{past && (
				<span
					className={cn(
						"absolute -top-px text-[10px] font-bold",
						loss
							? "-left-2.5 text-critical-icon"
							: "-right-2.5 text-success-icon",
					)}
				>
					{loss ? "‹" : "›"}
				</span>
			)}
		</div>
	);
}

function Approx() {
	return (
		<Tip content="An estimate until the marketplace reports it">
			<span className="ml-1 text-warning-text">≈</span>
		</Tip>
	);
}

// A known cost shows as it is: a sale keeps what its product cost when it
// came in, so changing the product's cost wouldn't change it. A sale with no
// cost can be given one, which fills in every sale of the product without one.
function Cost({ item: i, range }: { item: Item; range: string }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const [matching, setMatching] = useState(false);
	const closeMatch = useCallback(() => setMatching(false), []);
	// Escape closes without saving what was typed.
	const cancelled = useRef(false);

	if (i.costKnown) return <>{formatMoney(i.cost)}</>;
	if (i.productId === null && !i.awaitsMatch)
		return <span className="text-muted-foreground">Custom</span>;
	if (i.productId === null)
		return (
			<>
				<button
					type="button"
					onClick={() => setMatching(true)}
					className="text-critical-text hover:underline"
				>
					No product
				</button>
				<MatchDialog
					orderId={matching ? i.orderId : null}
					onClose={closeMatch}
				/>
			</>
		);
	if (i.productKind === "bundle")
		return (
			<Tip content="A tool set costs its parts; one of them has no cost">
				<Link
					to="/products/$sku"
					params={{ sku: i.sku ?? "" }}
					className="text-critical-text hover:underline"
				>
					A part has no cost
				</Link>
			</Tip>
		);
	if (!editing)
		return (
			<button
				type="button"
				onClick={() => {
					setValue("");
					cancelled.current = false;
					setEditing(true);
				}}
				className="rounded px-1.5 py-0.5 font-semibold text-critical-text hover:bg-surface"
			>
				Set cost
			</button>
		);

	const productId = i.productId;
	const sku = i.sku;
	async function save() {
		const unitCost = Number(value);
		if (cancelled.current || value.trim() === "") return setEditing(false);
		if (!Number.isFinite(unitCost) || unitCost < 0) {
			toast.error(`"${value}" isn't a cost`);
			return;
		}
		setEditing(false);
		const r = await optimism.change({
			label: `Setting ${sku}'s cost`,
			patch: itemsData.patch(range, (list) =>
				list.map((x) => {
					if (x.productId !== productId || x.costKnown) return x;
					// As the view counts it: units back on the shelf, or on
					// their way, cost nothing.
					const cost = unitCost * (x.quantity - x.restocked - x.returning);
					return {
						...x,
						cost,
						costKnown: true,
						profit: x.profit - cost,
						complete:
							x.feesStatus !== "estimated" &&
							(x.labelsStatus === "known" || x.labelsStatus === "not_needed") &&
							x.returning === 0,
					};
				}),
			),
			send: () => setProductCost({ data: { productId, unitCost } }),
		});
		if (r)
			toast.success(`${sku} costs ${formatMoney(unitCost)} each`, {
				description: "Every sale of it without a cost now uses this.",
			});
	}

	return (
		<input
			// biome-ignore lint/a11y/noAutofocus: opened by clicking "Set cost"
			autoFocus
			inputMode="decimal"
			value={value}
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				else if (e.key === "Escape") {
					cancelled.current = true;
					e.currentTarget.blur();
				}
			}}
			onBlur={save}
			placeholder="Each"
			aria-label={`Cost of one ${sku}`}
			className="h-7 w-20 rounded-md border border-input px-2 text-right outline-none focus:border-ring focus:ring-1 focus:ring-ring"
		/>
	);
}
