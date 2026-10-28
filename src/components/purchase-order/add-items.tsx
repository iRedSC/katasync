import { Loader2 } from "lucide-react";
import { type RefObject, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AddFilter, SortMenu } from "#/components/filter-menu";
import { FilterSearch } from "#/components/filter-search";
import { Card } from "#/components/page";
import { remoteFor, usePurchaseOrderSearch } from "#/components/po-search";
import { SortHeader } from "#/components/sort-header";
import { Button } from "#/components/ui/button";
import { formatCount, formatMoney } from "#/lib/format";
import { ids } from "#/lib/optimism";
import { productLanguage } from "#/products/language";
import { facetsOf, sortValuesOf, stateOf } from "#/products/rows";
import { type Filter, facetCounts, parseQuery } from "#/products/search";
import type { Sort } from "#/products/sort";
import { orderedItems } from "#/purchasing/sets";
import {
	addProductToPurchaseOrder,
	addRecommended,
	type BrowseRow,
	browseForPurchaseOrder,
	type PurchaseOrderDetail,
} from "#/server/purchasing";
import {
	type Candidate,
	COLUMNS,
	candidateRows,
	isSearching,
	type Key,
	type Prepared,
	remoteWords,
} from "./add-items/candidates";
import { Row } from "./add-items/row";
import { browseLine, recommendedLine } from "./new-lines";
import { isUnsent, poData } from "./po-data";
import { useAction } from "./use-action";

const PAGE = 100;

type Load =
	| { state: "idle" }
	| { state: "loading" }
	| { state: "loaded"; rows: BrowseRow[] }
	| { state: "failed"; message: string };

// Under the lines: what to add to the PO. With nothing typed, a draft's
// recommendations: this supplier's products worth adding, filled to their
// max, in the order the suggestion ranks them. Typing searches everything
// this supplier sells in the product list's language (^!velocity puts the
// fastest sellers first), then products from anyone else by name, SKU, or
// barcode, so a scan finds whatever it is. Enter adds the first row and
// opens its quantity; Add leaves the list where it is. Headers sort.
export function AddItems({
	detail: d,
	total,
	inputRef,
	onFocusLine,
}: {
	detail: PurchaseOrderDetail;
	total: number;
	inputRef: RefObject<HTMLInputElement | null>;
	onFocusLine: (lineId: number) => void;
}) {
	const { busy, run, save } = useAction();
	const draft = isUnsent(d.order.status);
	// Sent POs: what's added stays here, the supplier isn't told.
	const sent = !draft;
	const [query, setQuery] = useState("");
	const [chips, setChips] = useState<Filter[]>([]);
	const [sort, setSort] = useState<Sort<Key>>([]);
	const [shown, setShown] = useState(PAGE);
	// The off-list product whose add is on its way, so its button can say so.
	const [adding, setAdding] = useState<number | null>(null);
	const q = useMemo(() => parseQuery(query), [query]);
	const searching = isSearching(q, chips);

	// This supplier's whole list, loaded the first time it's wanted.
	const [load, setLoad] = useState<Load>({ state: "idle" });
	const [attempt, setAttempt] = useState(0);
	const wanted = searching || load.state !== "idle";
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt is Try again
	useEffect(() => {
		if (!wanted) return;
		let current = true;
		setLoad({ state: "loading" });
		browseForPurchaseOrder({ data: { purchaseOrderId: d.order.id } }).then(
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
	}, [d.order.id, attempt, wanted]);
	const catalog = load.state === "loaded" ? load.rows : null;

	// Anyone else's products only come up for words, never for filters,
	// which only this supplier's list can answer.
	const words = remoteWords(q, chips);
	const { search, retry } = usePurchaseOrderSearch(d.order.id, words);
	const remote = useMemo(() => remoteFor(search, words), [search, words]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new load is a new now
	const now = useMemo(() => new Date(), [catalog]);
	const prepared = useMemo(
		() =>
			new Map(
				(catalog ?? []).map((row) => {
					const state = stateOf(row, now);
					const facets = facetsOf(row, state);
					const extra = [row.terms?.supplierSku, row.barcode].filter(
						(c): c is string => !!c,
					);
					return [
						row.id,
						{
							row,
							facets: { ...facets, text: [...facets.text, ...extra] },
							values: sortValuesOf(row, state),
						},
					] satisfies [number, Prepared];
				}),
			),
		[catalog, now],
	);
	const counts = useMemo(
		() => facetCounts([...prepared.values()].map((p) => p.facets)),
		[prepared],
	);
	const language = useMemo(() => productLanguage(counts), [counts]);

	const recs = draft ? d.recommended : [];
	const rows = useMemo(
		() => candidateRows({ recs, prepared, remote, chips, q, sort, sent }),
		[recs, prepared, remote, chips, q, sort, sent],
	);

	const onPo = new Map(d.lines.map((l) => [l.productId, l.id]));
	// What the PO already orders of each product, e.g. as a set's part, so
	// After PO counts it alongside the row's own quantity.
	const items = orderedItems(d.lines, d.setParts, d.supplier.id);
	const short = d.supplier.minimumOrder - total;

	function changeSort(next: Sort<Key>) {
		setSort(next);
		setShown(PAGE);
	}

	// Puts it on, and says which line it made, so Enter can open its
	// quantity. Recommendations and this supplier's products show at once,
	// under an id of their own until the server's comes back.
	async function add(c: Candidate): Promise<number | null> {
		const s = c.source;
		if (s.kind === "match") {
			// Only a match for the text in the box now: an earlier search's
			// product may have nothing to do with it.
			if (!(remote.state === "done" && remote.results.includes(s.match)))
				return null;
			setAdding(c.productId);
			const r = await run(
				() =>
					addProductToPurchaseOrder({
						data: { purchaseOrderId: d.order.id, productId: c.productId },
					}),
				(r) => (r.added ? `Added ${c.sku}` : `${c.sku} is already on this PO`),
			);
			setAdding(null);
			return r ? r.value.lineId : null;
		}
		const id = ids.provisional();
		const line =
			s.kind === "recommended"
				? recommendedLine(s.rec, id, d.supplier.id)
				: browseLine(s.row, id, d.supplier.id);
		save({
			label: `Adding ${c.sku}`,
			patch: poData.patch(d.order.id, (data) => ({
				...data,
				// A suggested PO's first change saves it as a draft.
				order:
					data.order.status === "suggested"
						? { ...data.order, status: "draft" }
						: data.order,
				lines: data.lines.some((l) => l.productId === c.productId)
					? data.lines
					: [...data.lines, line],
				recommended: data.recommended.filter(
					(x) => x.productId !== c.productId,
				),
			})),
			send: async () => {
				const res =
					s.kind === "recommended"
						? await addRecommended({
								data: {
									purchaseOrderId: d.order.id,
									productId: c.productId,
									quantity: c.quantity,
								},
							}).then((r) => ({ added: r.added, lineId: r.line.id }))
						: await addProductToPurchaseOrder({
								data: { purchaseOrderId: d.order.id, productId: c.productId },
							});
				ids.confirm(id, res.lineId);
				return res;
			},
			success: (res) =>
				res.added ? `Added ${c.sku}` : `${c.sku} is already on this PO`,
		});
		return id;
	}

	// Enter: the first row goes on and its quantity opens, as a scan wants.
	// One already on the PO opens its line instead.
	async function submit() {
		const first = rows[0];
		// While anyone else's products may still come, one could lead.
		if (remote.state === "pending") return;
		if (!searching || !first || busy || first.warning?.blocks) return;
		const lineId = onPo.get(first.productId);
		if (lineId !== undefined) {
			toast(`${first.sku} is already on this PO`);
			onFocusLine(lineId);
			setQuery("");
			return;
		}
		const added = await add(first);
		if (added === null) return;
		setQuery("");
		onFocusLine(added);
	}

	const header = (
		key: Key,
		label: string,
		className?: string,
		tip?: string,
	) => (
		<SortHeader
			column={key}
			sort={sort}
			onSort={changeSort}
			className={className}
			tip={tip}
		>
			{label}
		</SortHeader>
	);

	const loading =
		searching && (load.state === "loading" || load.state === "idle");
	return (
		<Card
			flush
			// Suggestions open below the box, past the card's edge when the list
			// is short.
			className="overflow-visible"
			title="Add more items"
			aside={draft && short > 0 ? `${formatMoney(short)} short` : undefined}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Escape clears, then leaves the box */}
			<div
				className="flex items-start gap-1 px-4 pb-3"
				onKeyDown={(e) => {
					if (e.key !== "Escape" || e.target !== inputRef.current) return;
					e.stopPropagation();
					if (query || chips.length) {
						setQuery("");
						setChips([]);
					} else inputRef.current?.blur();
				}}
			>
				<div className="relative min-w-0 flex-1">
					<FilterSearch
						inputRef={inputRef}
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
						language={language}
						sorting={{ sort, onSort: changeSort, columns: COLUMNS }}
						placeholder="Name, SKU, barcode, their SKU, or %status *class ^sort"
						onSubmit={submit}
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
				{remote.state === "pending" && (
					<Loader2 className="mt-2 size-4 shrink-0 animate-spin text-muted-foreground" />
				)}
			</div>
			{load.state === "failed" && searching ? (
				<div className="flex flex-col items-center gap-3 border-t px-4 py-10">
					<p className="text-critical-text">{load.message}</p>
					<Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
						Try again
					</Button>
				</div>
			) : loading ? (
				<p className="flex items-center justify-center gap-2 border-t px-4 py-10 text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					Loading
				</p>
			) : remote.state === "failed" && rows.length === 0 ? (
				<div className="flex flex-col items-center gap-3 border-t px-4 py-10">
					<p className="text-critical-text">{remote.message}</p>
					<Button variant="outline" onClick={retry}>
						Try again
					</Button>
				</div>
			) : rows.length === 0 && remote.state === "pending" ? (
				<p className="flex items-center justify-center gap-2 border-t px-4 py-10 text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					Searching
				</p>
			) : rows.length === 0 ? (
				// A sent PO has nothing to recommend; its box speaks for itself.
				(searching || draft) && (
					<p className="border-t px-4 py-6 text-center text-muted-foreground">
						{searching ? "No matches" : "Nothing recommended"}
					</p>
				)
			) : (
				<div className="overflow-x-auto border-t">
					{/* This supplier's rows still work; only anyone else's are missing. */}
					{remote.state === "failed" && (
						<div className="flex items-center justify-between gap-3 border-b bg-critical-surface px-4 py-2 text-sm">
							<span className="text-critical-text">
								Other suppliers' products: {remote.message}
							</span>
							<Button size="sm" variant="outline" onClick={retry}>
								Try again
							</Button>
						</div>
					)}
					{/* Laid out like the draft's lines above, read-only until added. */}
					<table className="w-full [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
						<thead>
							<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
								{header("name", "Product", "px-4")}
								{header("theirsku", "Their SKU")}
								{header("minimum", "MOQ / UOM")}
								{header("due", "Due")}
								{header("qty", "Qty", "text-right")}
								{header("onhand", "On hand → After PO", "text-center")}
								{header(
									"velocity",
									"Velocity",
									"text-center",
									"Units sold a month",
								)}
								{header("cost", "Cost", "text-right")}
								{header("amount", "Amount", "text-right")}
								<th className="px-4 py-2" />
							</tr>
						</thead>
						<tbody>
							{rows.slice(0, shown).map((c) => (
								<Row
									key={c.productId}
									c={c}
									lineId={onPo.get(c.productId)}
									ordered={
										(items.get(c.productId) ?? 0) +
										(onPo.has(c.productId) ? 0 : c.quantity * c.packSize)
									}
									adding={adding === c.productId}
									disabled={busy}
									onAdd={() => add(c)}
									onGoToLine={onFocusLine}
								/>
							))}
						</tbody>
					</table>
					{shown < rows.length && (
						<div className="flex justify-center border-t py-3">
							<Button
								variant="outline"
								onClick={() => setShown((n) => n + PAGE)}
							>
								Show {formatCount(Math.min(PAGE, rows.length - shown))} more
							</Button>
						</div>
					)}
				</div>
			)}
		</Card>
	);
}
