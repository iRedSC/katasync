import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { DamageRow } from "#/components/damage/damage-details";
import { ContextMenu, ContextMenuTrigger } from "#/components/ui/context-menu";
import { Tip } from "#/components/ui/tooltip";
import { groupBy } from "#/lib/group-by";
import { ids } from "#/lib/optimism";
import { cn } from "#/lib/utils";
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

export function LineTable({
	detail: d,
	lines,
	focus,
	onEditQuantity,
	onOpenDamage,
	onReportDamage,
	onQuantityDone,
}: {
	detail: PurchaseOrderDetail;
	lines: Line[];
	focus: LineFocus | null;
	onOpenDamage: (damageId: number) => void;
	onReportDamage: (line: Line) => void;
	// Opens a line's quantity, as adding it from the picker does.
	onEditQuantity: (lineId: number) => void;
	// A quantity opened by focus is done; enter says it was left with Enter.
	onQuantityDone: (enter: boolean) => void;
}) {
	const draft = isUnsent(d.order.status);
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
						<th className="px-4 py-2 font-medium">Product</th>
						<th className="px-3 py-2 font-medium whitespace-nowrap">
							Their SKU
						</th>
						<th className="px-3 py-2 font-medium whitespace-nowrap">
							MOQ / UOM
						</th>
						{draft ? (
							<th className="px-3 py-2 text-right font-medium">Qty</th>
						) : (
							<>
								<Tip content="As sent. The PDF still shows this.">
									<th className="px-3 py-2 text-right font-medium">
										Qty requested
									</th>
								</Tip>
								<th className="px-3 py-2 text-right font-medium">
									Qty expected
								</th>
							</>
						)}
						{draft && (
							<th className="px-3 py-2 text-center font-medium whitespace-nowrap">
								On hand → After PO
							</th>
						)}
						{draft && (
							<Tip content="Units sold a month">
								<th className="px-3 py-2 text-center font-medium whitespace-nowrap">
									Velocity
								</th>
							</Tip>
						)}
						<th className="px-3 py-2 text-right font-medium">Cost</th>
						<th className="px-4 py-2 text-right font-medium">Amount</th>
						{!draft && (
							<th className="px-4 py-2 text-right font-medium">Received</th>
						)}
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
							onReportDamage={() => onReportDamage(menuFor)}
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
