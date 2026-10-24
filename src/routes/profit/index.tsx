import { createFileRoute } from "@tanstack/react-router";
import { Receipt, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Card, EmptyState, Page } from "#/components/page";
import {
	PROFIT_DEFAULTS,
	ProfitViews,
	RangeTabs,
	rangeSearch,
} from "#/components/profit-nav";
import { Chip } from "#/components/profit-page/filter-chip";
import { SHOWS, type Show } from "#/components/profit-page/filters";
import { itemsData } from "#/components/profit-page/items-store";
import { Row } from "#/components/profit-page/row";
import { Th } from "#/components/profit-page/sort-header";
import { SORT_VALUE, type SortKey } from "#/components/profit-page/sorting";
import { Summary } from "#/components/profit-page/summary";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { channelName, formatCount } from "#/lib/format";
import { getProfitItems } from "#/server/profit";

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
												Contribution
											</Th>
											<th className="px-2.5 py-2 font-medium">
												<span className="sr-only">
													Contribution at a glance
												</span>
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
