import { ArrowDown, ArrowUp, Check, Loader2 } from "lucide-react";
import {
	type MouseEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { AddFilter, SortMenu } from "#/components/filter-menu";
import { FilterSearch } from "#/components/filter-search";
import { AbcBadge } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount, formatMoney, formatOrderQuantity } from "#/lib/format";
import { cn } from "#/lib/utils";
import { facetsOf, sortValuesOf, stateOf, stock } from "#/products/rows";
import {
	type Filter,
	facetCounts,
	matches,
	parseQuery,
} from "#/products/search";
import {
	isColumn,
	NUMBER,
	type Sort,
	type SortColumns,
	type SortTerm,
	sortRows,
	TEXT,
	withTerm,
} from "#/products/sort";
import { PRODUCT_SORTS } from "#/products/views";
import { type BrowseRow, browseForPurchaseOrder } from "#/server/purchasing";

export type { BrowseRow };

// Every product column but supplier, which is the same for all of them, and
// the supplier's own terms. Cost is what they charge for their unit.
const { supplier: _supplier, ...productColumns } = PRODUCT_SORTS;
const COLUMNS = {
	...productColumns,
	cost: { label: "Their price", ...NUMBER },
	each: { label: "Price each", ...NUMBER },
	pack: { label: "Pack size", ...NUMBER },
	minimum: { label: "Minimum order", ...NUMBER },
	theirsku: { label: "Their SKU", ...TEXT },
} as const satisfies SortColumns<string>;
type Key = keyof typeof COLUMNS;

type Load =
	| { state: "loading" }
	| { state: "loaded"; rows: BrowseRow[] }
	| { state: "failed"; message: string };

const PAGE = 100;

// Everything this PO's supplier sells, to filter and sort before adding. The
// search box takes the product list's language, so ^!velocity puts the
// fastest sellers first. Column headers sort too: click one to sort by it,
// again to flip it, Shift-click to break ties with it.
export function BrowseProducts({
	purchaseOrderId,
	supplierName,
	sent,
	open,
	onOpenChange,
	onPo,
	busy,
	onAdd,
	onGoToLine,
}: {
	purchaseOrderId: number;
	supplierName: string;
	// Sent POs: what's added stays here, the supplier isn't told.
	sent: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	// The line each product already has on this PO, by product id.
	onPo: ReadonlyMap<number, number>;
	busy: boolean;
	onAdd: (row: BrowseRow) => Promise<unknown>;
	onGoToLine: (lineId: number) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[calc(100svh-4rem)] flex-col gap-3 p-0 sm:max-w-6xl">
				<DialogHeader className="px-5 pt-5">
					<DialogTitle>Browse {supplierName}</DialogTitle>
					<DialogDescription>
						{sent
							? "Add something the supplier sent. They aren't told."
							: "Everything bought from them. Filter, sort, then add."}
					</DialogDescription>
				</DialogHeader>
				{/* Mounted only while open, so each opening loads fresh numbers. */}
				{open && (
					<Browser
						purchaseOrderId={purchaseOrderId}
						sent={sent}
						onPo={onPo}
						busy={busy}
						onAdd={onAdd}
						onGoToLine={(lineId) => {
							onOpenChange(false);
							onGoToLine(lineId);
						}}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function Browser({
	purchaseOrderId,
	sent,
	onPo,
	busy,
	onAdd,
	onGoToLine,
}: {
	purchaseOrderId: number;
	sent: boolean;
	onPo: ReadonlyMap<number, number>;
	busy: boolean;
	onAdd: (row: BrowseRow) => Promise<unknown>;
	onGoToLine: (lineId: number) => void;
}) {
	const [load, setLoad] = useState<Load>({ state: "loading" });
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt is Try again
	useEffect(() => {
		let current = true;
		setLoad({ state: "loading" });
		browseForPurchaseOrder({ data: { purchaseOrderId } }).then(
			(rows) => current && setLoad({ state: "loaded", rows }),
			(err) =>
				current &&
				setLoad({
					state: "failed",
					message: err instanceof Error ? err.message : String(err),
				}),
		);
		return () => {
			current = false;
		};
	}, [purchaseOrderId, attempt]);

	if (load.state === "loading")
		return (
			<p className="flex items-center justify-center gap-2 px-5 py-16 text-muted-foreground">
				<Loader2 className="size-4 animate-spin" />
				Loading their products
			</p>
		);
	if (load.state === "failed")
		return (
			<div className="flex flex-col items-center gap-3 px-5 py-16">
				<p className="text-critical-text">{load.message}</p>
				<Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
					Try again
				</Button>
			</div>
		);
	return (
		<Table
			rows={load.rows}
			sent={sent}
			onPo={onPo}
			busy={busy}
			onAdd={onAdd}
			onGoToLine={onGoToLine}
		/>
	);
}

function Table({
	rows,
	sent,
	onPo,
	busy,
	onAdd,
	onGoToLine,
}: {
	rows: BrowseRow[];
	sent: boolean;
	onPo: ReadonlyMap<number, number>;
	busy: boolean;
	onAdd: (row: BrowseRow) => Promise<unknown>;
	onGoToLine: (lineId: number) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [chips, setChips] = useState<Filter[]>([]);
	const [sort, setSort] = useState<Sort<Key>>([]);
	const [shown, setShown] = useState(PAGE);
	// The product whose add is on its way, so its button can say so.
	const [adding, setAdding] = useState<number | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new load is a new now
	const now = useMemo(() => new Date(), [rows]);
	const prepared = useMemo(
		() =>
			rows.map((row) => {
				const state = stateOf(row, now);
				const facets = facetsOf(row, state);
				const t = row.terms;
				return {
					row,
					// Their SKU searches too, as it does in the picker.
					facets: t?.supplierSku
						? { ...facets, text: [...facets.text, t.supplierSku] }
						: facets,
					values: {
						...sortValuesOf(row, state),
						cost: t?.cost ?? null,
						each: t?.cost == null ? null : t.cost / t.packSize,
						pack: t?.packSize ?? null,
						minimum: t?.minimumQuantity ?? null,
						theirsku: t?.supplierSku ?? null,
					} satisfies Record<Key, unknown>,
				};
			}),
		[rows, now],
	);
	const counts = useMemo(
		() => facetCounts(prepared.map((p) => p.facets)),
		[prepared],
	);
	const filtered = useMemo(() => {
		const q = parseQuery(query);
		const all = [...chips, ...q.filters];
		// A sort still being typed applies once it names a column exactly.
		const by = q.sorts.reduce<Sort<Key>>(
			(s, t) =>
				isColumn(t.value, COLUMNS)
					? withTerm(s, { key: t.value, desc: t.desc })
					: s,
			sort,
		);
		return sortRows(
			prepared.filter((p) => matches(p.facets, all, q.words)),
			by,
			(p) => p.values,
		);
	}, [prepared, query, chips, sort]);

	function changeSort(next: Sort<Key>) {
		setSort(next);
		setShown(PAGE);
	}
	// A header click sorts by that column alone, or flips it when it already
	// leads; Shift adds it as a tiebreaker, or flips it where it is.
	function sortBy(key: Key, e: MouseEvent) {
		const at = sort.find((t) => t.key === key);
		if (e.shiftKey) {
			changeSort(withTerm(sort, { key, desc: at ? !at.desc : false }));
			return;
		}
		const leads = sort.length === 1 && at;
		changeSort([{ key, desc: leads ? !at.desc : false }]);
	}

	async function add(row: BrowseRow) {
		setAdding(row.id);
		await onAdd(row);
		setAdding(null);
	}

	const header = (key: Key, children: ReactNode, className?: string) => (
		<SortHeader
			term={sort.find((t) => t.key === key)}
			rank={sort.length > 1 ? sort.findIndex((t) => t.key === key) + 1 : 0}
			onClick={(e) => sortBy(key, e)}
			title={`Sort by ${COLUMNS[key].label}. Shift-click to break ties`}
			className={className}
		>
			{children}
		</SortHeader>
	);

	return (
		<>
			<div className="flex items-start gap-1 px-5">
				<div className="min-w-0 flex-1">
					<FilterSearch
						inputRef={input}
						text={query}
						onText={(t) => {
							setQuery(t);
							setShown(PAGE);
						}}
						chips={chips}
						onChips={(next) => {
							setChips(next);
							setShown(PAGE);
						}}
						counts={counts}
						sort={sort}
						onSort={changeSort}
						columns={COLUMNS}
						placeholder="Search, filter (%needs ordering *A >=3), or sort (^!velocity ^cost)"
					/>
				</div>
				<AddFilter
					counts={counts}
					onAdd={(f) => {
						setChips([...chips, f]);
						setShown(PAGE);
					}}
				/>
				<SortMenu sort={sort} onSort={changeSort} columns={COLUMNS} />
			</div>
			<p className="px-5 text-xs text-muted-foreground tabular-nums">
				{filtered.length === rows.length
					? `${formatCount(rows.length)} products`
					: `${formatCount(filtered.length)} of ${formatCount(rows.length)} products`}
			</p>
			<div className="min-h-0 flex-1 overflow-y-auto border-t">
				<table className="w-full">
					<thead className="sticky top-0 z-10 bg-subtle">
						<tr className="border-b text-left text-xs text-muted-foreground">
							{header("name", "Product", "px-5")}
							{header("class", "Class", "text-center")}
							{header("inventory", "Inventory", "text-right")}
							{header("onorder", "On order", "hidden text-right md:table-cell")}
							{header(
								"velocity",
								"Sold a month",
								"hidden text-right md:table-cell",
							)}
							{header(
								"reorder",
								"To reorder",
								"hidden text-right lg:table-cell",
							)}
							{header("cost", "Their price", "text-right")}
							<th className="px-5 py-2" />
						</tr>
					</thead>
					<tbody>
						{filtered.slice(0, shown).map(({ row }) => {
							const lineId = onPo.get(row.id);
							// Sets come as their parts on a sent PO, so add those.
							const blocked = sent && row.kind === "bundle";
							const t = row.terms;
							return (
								<tr
									key={row.id}
									className="border-t first:border-t-0 hover:bg-subtle"
								>
									<td className="w-full max-w-0 px-5 py-2">
										<div className="flex items-center gap-3">
											<ProductImage src={row.imageUrl} />
											<div className="min-w-0 flex-1">
												<ProductName
													name={row.name}
													variantName={row.variantName}
												/>
												<div className="flex gap-2 text-xs text-muted-foreground">
													<span>{row.sku}</span>
													{t?.supplierSku && (
														<span>Their SKU {t.supplierSku}</span>
													)}
													{row.kind === "bundle" && <span>Tool set</span>}
													{row.kind === "kit" && <span>Kit</span>}
												</div>
											</div>
										</div>
									</td>
									<td className="px-2 py-2 text-center">
										<AbcBadge abc={row.abc} />
									</td>
									<td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
										{formatCount(stock(row))}
									</td>
									<td className="hidden px-3 py-2 text-right whitespace-nowrap tabular-nums md:table-cell">
										{row.onOrder > 0 ? formatCount(row.onOrder) : ""}
									</td>
									<td className="hidden px-3 py-2 text-right whitespace-nowrap tabular-nums md:table-cell">
										{row.dailyDemand > 0
											? formatCount(Math.round(row.dailyDemand * 30 * 10) / 10)
											: ""}
									</td>
									<td className="hidden px-3 py-2 text-right whitespace-nowrap tabular-nums lg:table-cell">
										{row.reorder ? formatOrderQuantity(row.reorder) : ""}
									</td>
									<td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
										{t?.cost == null ? (
											<span className="text-muted-foreground">No price</span>
										) : (
											<>
												{formatMoney(t.cost)}
												{t.packSize > 1 && (
													<span className="text-xs text-muted-foreground">
														{" "}
														/ {t.unit}
													</span>
												)}
											</>
										)}
									</td>
									<td className="px-5 py-2 text-right whitespace-nowrap">
										{lineId !== undefined ? (
											<Button
												size="sm"
												variant="ghost"
												onClick={() => onGoToLine(lineId)}
												title="On this PO. Click to go to its line"
											>
												<Check />
												Added
											</Button>
										) : (
											<Button
												size="sm"
												variant="outline"
												disabled={busy || blocked}
												title={
													blocked
														? "Tool set: add the parts that came"
														: undefined
												}
												onClick={() => add(row)}
											>
												{adding === row.id && (
													<Loader2 className="animate-spin" />
												)}
												Add
											</Button>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
				{filtered.length === 0 && (
					<p className="py-16 text-center text-muted-foreground">
						{rows.length === 0
							? "Nothing is bought from this supplier yet."
							: "No products match. Try a shorter search, or remove a chip."}
					</p>
				)}
				{shown < filtered.length && (
					<div className="flex justify-center py-3">
						<Button variant="outline" onClick={() => setShown((n) => n + PAGE)}>
							Show {formatCount(Math.min(PAGE, filtered.length - shown))} more
						</Button>
					</div>
				)}
			</div>
		</>
	);
}

function SortHeader({
	term,
	rank,
	onClick,
	title,
	className,
	children,
}: {
	term: SortTerm<Key> | undefined;
	// Its place among several sort columns, or 0 when it's alone or unsorted.
	rank: number;
	onClick: (e: MouseEvent) => void;
	title: string;
	className?: string;
	children: ReactNode;
}) {
	const Arrow = term?.desc ? ArrowDown : ArrowUp;
	const right = className?.includes("text-right");
	return (
		<th
			className={cn("px-3 py-2 font-medium", className)}
			aria-sort={term ? (term.desc ? "descending" : "ascending") : undefined}
		>
			<button
				type="button"
				onClick={onClick}
				title={title}
				className={cn(
					"inline-flex items-center gap-1 hover:text-foreground",
					right && "flex-row-reverse",
					term && "text-foreground",
				)}
			>
				{children}
				{term && <Arrow className="size-3" />}
				{term && rank > 0 && <span className="tabular-nums">{rank}</span>}
			</button>
		</th>
	);
}
