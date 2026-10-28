import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { DamageKind } from "#/components/damage/damage";
import { DamageRow } from "#/components/damage/damage-details";
import { SortHeader } from "#/components/sort-header";
import { ContextMenu, ContextMenuTrigger } from "#/components/ui/context-menu";
import { groupBy } from "#/lib/group-by";
import { ids } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { NUMBER, type Sort, sortRows, TEXT } from "#/products/sort";
import { lineCents } from "#/purchasing/discount";
import { lineNumbers } from "#/purchasing/line-numbers";
import {
	orderedItems,
	partState,
	setCoverage,
	setsOf,
} from "#/purchasing/sets";
import type { PurchaseOrderDetail } from "#/server/purchasing";
import { LineMenu } from "./line-menu";
import { NoteDialog, NoteRow, notable } from "./line-note";
import { LineRow } from "./line-row";
import { isUnsent } from "./po-data";
import { SetPartRow } from "./set-parts";
import type { Line, LineFocus, QuantityPreview } from "./types";

// What a header click sorts lines by. Only how they show: the PO, its PDF,
// and the email keep the order they were added in.
const LINE_COLUMNS = {
	name: { label: "Product", ...TEXT },
	theirsku: { label: "Their SKU", ...TEXT },
	minimum: { label: "MOQ / UOM", ...NUMBER },
	requested: { label: "Qty requested", ...NUMBER },
	qty: { label: "Qty", ...NUMBER },
	onhand: { label: "On hand", ...NUMBER },
	velocity: { label: "Velocity", ...NUMBER },
	cost: { label: "Cost", ...NUMBER },
	amount: { label: "Amount", ...NUMBER },
	received: { label: "Received", ...NUMBER },
} as const;
export type LineSort = Sort<keyof typeof LINE_COLUMNS>;

const lineValues = (l: Line) => ({
	name: l.name,
	theirsku: l.supplierSku,
	minimum: l.minimumQuantity,
	requested: l.sentQuantity,
	qty: l.quantity,
	onhand: l.onHand,
	velocity: l.why?.dailyDemand ?? null,
	cost: l.unitCost,
	amount: lineCents(l, l.discounts),
	received: l.received,
});

export function LineTable({
	detail: d,
	lines: unsorted,
	sort,
	onSort,
	focus,
	onEditQuantity,
	onOpenDamage,
	onReportDamage,
	onQuantityDone,
}: {
	detail: PurchaseOrderDetail;
	lines: Line[];
	// Shared by the Incoming and Received cards, so their columns agree.
	sort: LineSort;
	onSort: (sort: LineSort) => void;
	focus: LineFocus | null;
	onOpenDamage: (damageId: number) => void;
	onReportDamage: (line: Line, kind: DamageKind) => void;
	// Opens a line's quantity, as adding it from the picker does.
	onEditQuantity: (lineId: number) => void;
	// A quantity opened by focus is done; enter says it was left with Enter.
	onQuantityDone: (enter: boolean) => void;
}) {
	const draft = isUnsent(d.order.status);
	const lines = useMemo(
		() => (sort.length === 0 ? unsorted : sortRows(unsorted, sort, lineValues)),
		[unsorted, sort],
	);
	// Set parts and damages by line, grouped once per data version rather than
	// filtered again for every row.
	const partsByLine = useMemo(
		() => groupBy(d.setParts, (r) => r.lineId),
		[d.setParts],
	);
	const damagesByLine = useMemo(
		() => groupBy(d.damages, (r) => r.lineId),
		[d.damages],
	);
	// The focused line scrolls into view.
	const focusedRow = useRef<HTMLTableRowElement>(null);
	useEffect(() => {
		if (focus) focusedRow.current?.scrollIntoView({ block: "nearest" });
	}, [focus]);
	const [preview, setPreview] = useState<QuantityPreview | null>(null);
	const [menuFor, setMenuFor] = useState<Line | null>(null);
	// Looked up by id, so the dialog edits the line as it is now.
	const [noteFor, setNoteFor] = useState<number | null>(null);
	const noteLine = lines.find(
		(l) => noteFor !== null && ids.same(l.id, noteFor),
	);
	const canNote = notable(d.order.status);
	// Counted over the whole PO, as the PDF counts them, though this table may
	// hold only some of its lines.
	const numbers = lineNumbers(d.lines, d.order.sentAt !== null);
	// Sets opened or closed by hand; the rest are open while they're missing
	// a part.
	const [opened, setOpened] = useState<ReadonlyMap<number, boolean>>(new Map());
	const quantities = new Map(
		preview ? [[preview.lineId, preview.quantity]] : [],
	);
	// What the draft orders of each product once sent, sets' parts included.
	const items = orderedItems(d.lines, d.setParts, d.supplier.id, quantities);
	// Each line only sets or clears its own preview.
	const previewFor = (lineId: number) => (quantity: number | null) =>
		setPreview((prev) =>
			quantity === null
				? prev?.lineId === lineId
					? null
					: prev
				: { lineId, quantity },
		);
	const toggle = (lineId: number, open: boolean) =>
		setOpened((prev) => new Map(prev).set(lineId, open));
	// A set line's parts, where each comes from, and how it shows.
	const setFor = (l: Line) => {
		if (l.kind !== "bundle") return null;
		const sets = setsOf({ ...l, quantity: quantities.get(l.id) ?? l.quantity });
		const parts = (partsByLine.get(l.id) ?? []).map((part) => ({
			part,
			state: partState(part, sets, d.supplier.id),
		}));
		const coverage = setCoverage(parts.map((p) => p.state));
		const here = parts.filter((p) => p.state.kind === "here");
		return {
			sets,
			parts,
			coverage,
			open: opened.get(l.id) ?? coverage.short > 0,
			amount: here.some((p) => p.part.unitCost === null)
				? null
				: here.reduce(
						(n, { part: p }) =>
							n + ((sets * p.perSet) / p.packSize) * (p.unitCost ?? 0),
						0,
					),
		};
	};
	const header = (
		key: keyof typeof LINE_COLUMNS,
		label: string,
		className?: string,
		tip?: string,
	) => (
		<SortHeader
			column={key}
			sort={sort}
			onSort={onSort}
			className={className}
			tip={tip}
		>
			{label}
		</SortHeader>
	);
	if (lines.length === 0)
		return (
			<p className="px-4 py-6 text-center text-muted-foreground">
				Nothing on this PO.
			</p>
		);
	return (
		// Scrolls sideways rather than squeeze a column when there's no room.
		<div className="overflow-x-auto">
			{/* After sending, lines split across the Incoming and Received cards;
			    fixed widths keep their columns lined up. */}
			<table
				className={cn(
					"w-full [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap",
					!draft && "min-w-[60rem] table-fixed",
				)}
			>
				{!draft && (
					<colgroup>
						<col />
						<col className="w-24" />
						<col className="w-24" />
						<col className="w-28" />
						<col className="w-28" />
						<col className="w-24" />
						<col className="w-24" />
						<col className="w-56" />
					</colgroup>
				)}
				<thead>
					<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
						{header("name", "Product", "px-4")}
						{header("theirsku", "Their SKU")}
						{header("minimum", "MOQ / UOM")}
						{draft ? (
							header("qty", "Qty", "text-right")
						) : (
							<>
								{header(
									"requested",
									"Qty requested",
									"text-right",
									"As sent. The PDF still shows this.",
								)}
								{header("qty", "Qty expected", "text-right")}
							</>
						)}
						{draft && header("onhand", "On hand → After PO", "text-center")}
						{draft &&
							header(
								"velocity",
								"Velocity",
								"text-center",
								"Units sold a month",
							)}
						{header("cost", "Cost", "text-right")}
						{header("amount", "Amount", "px-4 text-right")}
						{!draft && header("received", "Received", "px-4 text-right")}
					</tr>
				</thead>
				{/* One menu for the whole table: it acts on the line that was
				    right-clicked. */}
				<ContextMenu>
					<ContextMenuTrigger asChild>
						<tbody>
							{lines.map((l) => {
								const set = setFor(l);
								return (
									<Fragment key={l.id}>
										<LineRow
											detail={d}
											line={l}
											lineNo={numbers.get(l.id) ?? null}
											set={set}
											focus={focus}
											focusedRow={focusedRow}
											items={items}
											previewing={preview !== null}
											previewFor={previewFor}
											toggle={toggle}
											onMenu={() => setMenuFor(l)}
											onQuantityDone={onQuantityDone}
										/>
										{l.receivingNote && (
											<NoteRow
												note={l.receivingNote}
												// Only sent and closed POs have notes, when the table has 8.
												columns={8}
												onOpen={canNote ? () => setNoteFor(l.id) : null}
												onContextMenu={() => setMenuFor(l)}
											/>
										)}
										{(damagesByLine.get(l.id) ?? []).map((x) => (
											<DamageRow
												key={`damage${x.id}`}
												damage={x}
												// Damage only exists once sent, when the table has 8.
												columns={8}
												onOpen={() => onOpenDamage(x.id)}
												onContextMenu={() => setMenuFor(l)}
											/>
										))}
										{set?.open &&
											set.parts.map(({ part, state }) => (
												<SetPartRow
													key={part.productId}
													line={l}
													part={part}
													state={state}
													sets={set.sets}
													ordered={items.get(part.productId) ?? 0}
												/>
											))}
									</Fragment>
								);
							})}
						</tbody>
					</ContextMenuTrigger>
					{menuFor && (
						<LineMenu
							line={menuFor}
							detail={d}
							onEditQuantity={() => onEditQuantity(menuFor.id)}
							onReportDamage={(kind) => onReportDamage(menuFor, kind)}
							onNote={canNote ? () => setNoteFor(menuFor.id) : null}
						/>
					)}
				</ContextMenu>
				{noteLine && (
					<NoteDialog
						line={noteLine}
						purchaseOrderId={d.order.id}
						onClose={() => setNoteFor(null)}
					/>
				)}
			</table>
		</div>
	);
}
