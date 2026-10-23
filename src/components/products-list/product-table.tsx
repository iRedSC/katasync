import { useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { Card } from "#/components/page";
import {
	type CellContext,
	COLUMNS,
	type ColumnKey,
	FROM_CLASS,
	LENSES,
	type LensKey,
} from "#/components/products-list/columns";
import { RowMenu } from "#/components/products-list/row-menu";
import { toggled } from "#/components/products-list/selection";
import { ContextMenu, ContextMenuTrigger } from "#/components/ui/context-menu";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import { useRowLink } from "#/lib/row-link";
import { cn } from "#/lib/utils";
import type { StockState } from "#/products/rows";
import { describeTerm, withTerm } from "#/products/sort";
import { PRODUCT_SORTS, type ProductSort } from "#/products/views";
import type { ProductRow } from "#/server/catalog";

type Props = {
	lens: LensKey;
	// The page of the list to show, without the pinned rows.
	rows: ProductRow[];
	// Every product the search matches, which the header's tick selects.
	matched: ProductRow[];
	// Ticked before the list last changed; shown in a group at the top.
	pinned: ProductRow[];
	selected: ReadonlySet<number>;
	onSelected: (next: ReadonlySet<number>) => void;
	sort: ProductSort;
	onSort: (sort: ProductSort) => void;
	stateFor: (p: ProductRow) => StockState;
	now: Date;
	adding: ReadonlySet<number>;
	onAddToPo: (p: ProductRow) => void;
	onCount: (p: ProductRow) => void;
};

// The product list as a table: the lens picks the columns, every header
// sorts, and the first column ticks rows for the action bar.
export function ProductTable(props: Props) {
	const { lens, rows, matched, pinned, selected, onSelected } = props;
	const navigate = useNavigate();
	const columns: ColumnKey[] = ["product", ...LENSES[lens].columns];
	// The product the right-click menu acts on.
	const [menuFor, setMenuFor] = useState<ProductRow | null>(null);
	const [groupOpen, setGroupOpen] = useState(false);
	// Where the last tick was, so a shift-click ticks everything between.
	const anchor = useRef<number | null>(null);

	const ticked = matched.filter((p) => selected.has(p.id)).length;
	const pinnedTicked = pinned.filter((p) => selected.has(p.id)).length;

	function tick(p: ProductRow, e: MouseEvent) {
		const on = !selected.has(p.id);
		const from = rows.findIndex((r) => r.id === anchor.current);
		const to = rows.findIndex((r) => r.id === p.id);
		const ids =
			e.shiftKey && from >= 0 && to >= 0
				? rows
						.slice(Math.min(from, to), Math.max(from, to) + 1)
						.map((r) => r.id)
				: [p.id];
		anchor.current = p.id;
		onSelected(toggled(selected, ids, on));
	}

	const body = (list: ProductRow[], inGroup: boolean) =>
		list.map((p) => (
			<Row
				key={`${inGroup ? "pin" : "row"}-${p.id}`}
				product={p}
				columns={columns}
				ticked={selected.has(p.id)}
				onTick={(e) => tick(p, e)}
				onMenu={() => setMenuFor(p)}
				inGroup={inGroup}
				{...props}
			/>
		));

	return (
		// Clipped rather than hidden, so the header can stick under the app bar.
		<Card flush className="overflow-clip">
			<table className="w-full">
				<thead className="sticky top-14 z-10">
					<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
						<th className="w-10 pl-4">
							<Checkbox
								label="Tick every match"
								checked={ticked > 0 && ticked === matched.length}
								mixed={ticked > 0 && ticked < matched.length}
								onChange={() =>
									onSelected(
										toggled(
											selected,
											matched.map((p) => p.id),
											ticked < matched.length,
										),
									)
								}
							/>
						</th>
						{columns.map((key) => (
							<Header key={key} column={key} {...props} />
						))}
					</tr>
				</thead>
				<ContextMenu>
					<ContextMenuTrigger asChild>
						<tbody>
							{pinned.length > 0 && pinnedTicked > 0 && (
								<>
									<tr className="border-b bg-info-fill/40">
										<td className="w-10 pl-4">
											<Checkbox
												label="Untick the selected group"
												checked={pinnedTicked === pinned.length}
												mixed={pinnedTicked < pinned.length}
												onChange={() =>
													onSelected(
														toggled(
															selected,
															pinned.map((p) => p.id),
															pinnedTicked < pinned.length,
														),
													)
												}
											/>
										</td>
										<td colSpan={columns.length} className="p-0">
											<button
												type="button"
												onClick={() => setGroupOpen((o) => !o)}
												aria-expanded={groupOpen}
												className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-sm font-medium"
											>
												<ChevronRight
													className={cn(
														"size-4 transition-transform",
														groupOpen && "rotate-90",
													)}
												/>
												Selected
												<span className="text-muted-foreground tabular-nums">
													({formatCount(pinnedTicked)})
												</span>
											</button>
										</td>
									</tr>
									{groupOpen && body(pinned, true)}
								</>
							)}
							{body(rows, false)}
						</tbody>
					</ContextMenuTrigger>
					{menuFor && (
						<RowMenu
							product={menuFor}
							onOpen={(p) =>
								navigate({ to: "/products/$sku", params: { sku: p.sku } })
							}
							onAddToPo={props.onAddToPo}
							adding={props.adding}
							onCount={props.onCount}
						/>
					)}
				</ContextMenu>
			</table>
		</Card>
	);
}

function Row({
	product: p,
	columns,
	ticked,
	onTick,
	onMenu,
	inGroup,
	stateFor,
	now,
	adding,
	onAddToPo,
	onCount,
}: Props & {
	product: ProductRow;
	columns: ColumnKey[];
	ticked: boolean;
	onTick: (e: MouseEvent) => void;
	onMenu: () => void;
	inGroup: boolean;
}) {
	const { link } = useRowLink();
	const context: CellContext = {
		product: p,
		state: stateFor(p),
		now,
		busy: adding.has(p.id),
		onAddToPo,
		onCount,
	};
	return (
		<tr
			{...link({ to: "/products/$sku", params: { sku: p.sku } })}
			onContextMenu={onMenu}
			className={cn(
				"cursor-pointer border-t first:border-t-0 hover:bg-subtle",
				ticked && "bg-primary/5 hover:bg-primary/10",
				inGroup && "animate-in fade-in",
			)}
		>
			<td className="w-10 pl-4">
				<Checkbox label={`Tick ${p.sku}`} checked={ticked} onChange={onTick} />
			</td>
			{columns.map((key) => {
				const c = COLUMNS[key];
				return (
					<td
						key={key}
						className={cn(
							"px-3 py-2 whitespace-nowrap",
							// Takes the width the other columns leave, so long names end
							// in "…" instead of pushing them off the card.
							key === "product" &&
								"w-full max-w-0 min-w-64 px-2 whitespace-normal",
							c.align === "right" && "text-right",
							c.align === "center" && "text-center",
							c.from && FROM_CLASS[c.from],
						)}
					>
						{c.cell(context)}
					</td>
				);
			})}
		</tr>
	);
}

// A header that sorts by its column. A click sorts by it alone, or flips it
// when it already leads; shift-click adds it as a tiebreaker.
function Header({
	column,
	sort,
	onSort,
}: Props & {
	column: ColumnKey;
}) {
	const c = COLUMNS[column];
	const at = sort.findIndex((t) => t.key === c.sort);
	const term = sort[at];
	const Arrow = term?.desc ? ArrowDown : ArrowUp;

	function click(e: MouseEvent) {
		const next = term
			? { ...term, desc: !term.desc }
			: { key: c.sort, desc: c.firstDesc ?? false };
		if (e.shiftKey) onSort(withTerm(sort, next));
		else
			onSort([at === 0 ? next : { key: c.sort, desc: c.firstDesc ?? false }]);
	}

	return (
		<th
			aria-sort={
				at === 0 ? (term?.desc ? "descending" : "ascending") : undefined
			}
			className={cn(
				"px-3 py-0 font-medium whitespace-nowrap",
				column === "product" && "px-2",
				c.from && FROM_CLASS[c.from],
			)}
		>
			<Tip
				content={
					term
						? `${describeTerm(term, PRODUCT_SORTS)}. Click to flip, shift-click to add a tiebreaker`
						: c.tip
				}
			>
				<button
					type="button"
					onClick={click}
					className={cn(
						"group inline-flex h-9 w-full items-center gap-1 hover:text-foreground",
						c.align === "right" && "justify-end",
						c.align === "center" && "justify-center",
						term && "text-foreground",
					)}
				>
					{c.label}
					{term ? (
						<span className="inline-flex items-center text-link">
							<Arrow className="size-3.5" />
							{sort.length > 1 && (
								<span className="text-[10px] tabular-nums">{at + 1}</span>
							)}
						</span>
					) : (
						<ArrowDown className="size-3.5 opacity-0 transition-opacity group-hover:opacity-40" />
					)}
				</button>
			</Tip>
		</th>
	);
}

function Checkbox({
	label,
	checked,
	mixed = false,
	onChange,
}: {
	label: string;
	checked: boolean;
	mixed?: boolean;
	onChange: (e: MouseEvent) => void;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = mixed;
	}, [mixed]);
	return (
		<input
			ref={ref}
			type="checkbox"
			aria-label={label}
			checked={checked}
			// onClick, not onChange: only the click carries the shift key.
			onClick={onChange}
			onChange={() => {}}
			className="size-4 cursor-pointer accent-primary align-middle"
		/>
	);
}
