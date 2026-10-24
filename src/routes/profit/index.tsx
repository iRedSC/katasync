import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Receipt, SearchX } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { FilterBar, useSearchRows } from "#/components/filter-bar";
import { Card, EmptyState, Page } from "#/components/page";
import { PROFIT_DEFAULTS, ProfitViews } from "#/components/profit-nav";
import { itemsData } from "#/components/profit-page/items-store";
import { Row } from "#/components/profit-page/row";
import { type ProfitChip, profitSearch } from "#/components/profit-page/search";
import { Th } from "#/components/profit-page/sort-header";
import {
	PROFIT_SORTS,
	type SortKey,
	sortValuesOf,
} from "#/components/profit-page/sorting";
import { Summary } from "#/components/profit-page/summary";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { formatCount } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { ALL_TIME, isAllTime, parsePeriod, spellPeriod } from "#/lib/period";
import type { Sort } from "#/products/sort";
import { getProfitItems } from "#/server/profit";

// Every item sold in a stretch of time and what it made: its sales less its
// cost, less its share of its order's fees, labels, refunds and adjustments
// (order_line_profit). A product with no cost can be given one right here.
// The stretch is the search's ~ chip, which the page loads by; removing it
// is all time.

const VIEW = "/profit";
const DEFAULT = PROFIT_DEFAULTS[VIEW];

export const Route = createFileRoute("/profit/")({
	// The period as lib/period.ts spells it, left out when it's the default.
	// Older links named it range.
	validateSearch: (search: Record<string, unknown>): { period?: string } => {
		const raw = search.period ?? search.range;
		const p = typeof raw === "string" ? parsePeriod(raw) : null;
		return p && spellPeriod(p) !== DEFAULT ? { period: spellPeriod(p) } : {};
	},
	loaderDeps: ({ search }) => ({ range: search.period ?? DEFAULT }),
	loader: ({ deps }) => getProfitItems({ data: { period: deps.range } }),
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
	const { period: range = DEFAULT } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const items = itemsData.useData(range, loaded.items);
	const input = useRef<HTMLInputElement>(null);
	const [text, setText] = useState("");
	const [others, setOthers] = useState<ProfitChip[]>([]);
	// Newest first, as the server sends them, until a column is picked.
	const [sort, setSort] = useState<Sort<SortKey>>([]);
	const [limit, setLimit] = useState(PAGE);
	const period = parsePeriod(range);

	// The period is a chip like the rest, but it lives in the URL and the
	// loader fetches by it. All time is no chip.
	const chips = useMemo<ProfitChip[]>(
		() =>
			!isAllTime(parsePeriod(range) ?? ALL_TIME)
				? [
						{ field: "sold", value: range, exclude: false, exact: true },
						...others,
					]
				: others,
		[range, others],
	);
	function setChips(next: ProfitChip[]) {
		const sold = next.find((c) => c.field === "sold")?.value ?? "..";
		if (sold !== range)
			navigate({ search: sold === DEFAULT ? {} : { period: sold } });
		setOthers(next.filter((c) => c.field !== "sold"));
		setLimit(PAGE);
	}

	const { idx, shown, filtering } = useSearchRows(
		profitSearch,
		items,
		chips,
		text,
		{ sort, columns: PROFIT_SORTS, values: sortValuesOf },
	);
	const sortBy = (key: SortKey) =>
		setSort((s) => [
			{ key, desc: s[0]?.key === key ? !s[0].desc : key !== "date" },
		]);
	useHotkeys({ "/": () => input.current?.focus() });

	return (
		<Page
			title="Profit"
			width="wide"
			actions={
				<ProfitViews
					view={VIEW}
					range={period?.kind === "range" ? period.key : null}
				/>
			}
		>
			{loaded.unshipped > 0 && (
				<p className="text-muted-foreground">
					{formatCount(loaded.unshipped)} more{" "}
					{loaded.unshipped === 1 ? "item waits" : "items wait"} for payment or
					shipping and will show once{" "}
					{loaded.unshipped === 1 ? "it ships" : "they ship"}.
				</p>
			)}
			<Summary items={shown} cut={loaded.cut} />
			<Card flush className="overflow-visible">
				<FilterBar
					search={profitSearch}
					idx={idx}
					inputRef={input}
					text={text}
					onText={(t) => {
						setText(t);
						setLimit(PAGE);
					}}
					chips={chips}
					onChips={setChips}
					sorting={{ sort, onSort: setSort, columns: PROFIT_SORTS }}
					placeholder="Search, or ~last_month $amazon %thin ^profit"
					className="border-b p-2"
				/>
				{items.length === 0 ? (
					<EmptyState icon={Receipt} title="Nothing shipped then" />
				) : shown.length === 0 && filtering ? (
					<EmptyState icon={SearchX} title="No items match" />
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
										<span className="sr-only">Contribution at a glance</span>
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
							Older items in this range aren't loaded. Pick a shorter range to
							see them.
						</p>
					)
				)}
			</Card>
		</Page>
	);
}
