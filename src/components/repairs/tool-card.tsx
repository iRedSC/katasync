import { Plus, Printer, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Card } from "#/components/page";
import type { IndexedProduct } from "#/components/transfers/add-product";
import { Button } from "#/components/ui/button";
import { formatMoney } from "#/lib/format";
import { ids } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { printPdf } from "#/printing/qz-client";
import { formatMinutes, hourlyRate } from "#/repairs/labor";
import { useDraft } from "./draft";
import { LaborList, NoteField } from "./labor-card";
import { AddedInShopify, PartsList } from "./parts-card";
import type { Detail, RepairActions, Tool } from "./repair-data";
import { ToolInput } from "./tool-input";

// The main side of a repair's page: each tool that came in, with its own
// labor and parts, then what's charged to the order as a whole, then a row
// to add another tool.

type Actions = RepairActions;

const sameTool = (a: number | null, b: number | null) =>
	a === null || b === null ? a === b : ids.same(a, b);

// What one tool or the order comes to: its time at the hourly rate, and
// its parts at Shopify's price. Null while a price is unknown.
function chargesOf(d: Detail, toolId: number | null) {
	const bench = d.repair.kind === "bench";
	const labor = d.labor.filter((l) => sameTool(l.toolId, toolId));
	const parts = d.parts.filter((p) => sameTool(p.toolId, toolId));
	const rate = d.laborVariants && !bench ? hourlyRate(d.laborVariants) : null;
	const minutes = labor.reduce((n, l) => n + l.minutes, 0);
	const total =
		bench || rate === null || parts.some((p) => !p.charged)
			? null
			: (rate * minutes) / 60 +
				parts.reduce((n, p) => n + (p.charged?.total ?? 0), 0);
	return { labor, parts, rate, minutes, total, bench };
}

function Totals({ minutes, total }: { minutes: number; total: number | null }) {
	if (minutes === 0 && total === null) return null;
	return (
		<span className="tabular-nums">
			{[
				minutes > 0 && formatMinutes(minutes),
				total ? formatMoney(total) : null,
			]
				.filter(Boolean)
				.join(", ")}
		</span>
	);
}

// Labor and parts under one tool or the order, each under a small heading.
function Charges({
	d,
	act,
	toolId,
	index,
	editable,
}: {
	d: Detail;
	act: Actions;
	toolId: number | null;
	index: IndexedProduct[];
	editable: boolean;
}) {
	const c = chargesOf(d, toolId);
	const heading = (text: string) => (
		<h3 className="border-t px-4 pt-3 pb-1 text-xs font-semibold text-muted-foreground">
			{text}
		</h3>
	);
	return (
		<>
			{(editable || c.labor.length > 0) && (
				<>
					{heading("Labor")}
					<LaborList
						labor={c.labor}
						rate={c.rate}
						bench={c.bench}
						editable={editable}
						onAdd={(minutes, note) => act.addLabor(toolId, minutes, note)}
						onEdit={(laborId, edit) => act.editLabor(laborId, edit)}
						onRemove={(laborId) => {
							const gone = c.labor.find((l) => l.id === laborId);
							void act.removeLabor(laborId).then(
								(done) =>
									done &&
									gone &&
									offerUndo("Time taken off", {
										undo: async () =>
											(await act.addLabor(gone.toolId, gone.minutes, gone.note))
												? "Time put back"
												: null,
									}),
							);
						}}
					/>
				</>
			)}
			{(editable || c.parts.length > 0) && (
				<>
					{heading("Parts")}
					<PartsList
						parts={c.parts}
						index={index}
						bench={c.bench}
						editable={editable}
						onSet={(part, quantity) => act.setPart(toolId, part, quantity)}
					/>
				</>
			)}
		</>
	);
}

export function ToolCard({
	d,
	act,
	tool: t,
	place,
	index,
	editable,
}: {
	d: Detail;
	act: Actions;
	tool: Tool;
	// Which of the repair's tools it is, from 1.
	place: number;
	index: IndexedProduct[];
	editable: boolean;
}) {
	const r = d.repair;
	const bench = r.kind === "bench";
	const several = d.tools.length > 1;
	const c = chargesOf(d, t.id);
	const problem = useDraft(t.problem, `problem-${t.id}`);
	// A bench job stays the product it came in as; its name is a label.
	const named = useDraft(
		{ tool: t.tool, productId: t.productId },
		`tool-${t.id}`,
		(a, b) => a.tool === b.tool && a.productId === b.productId,
	);
	const { tool, productId } = named.value;

	async function remove() {
		const done = await act.removeTool(t.id);
		if (!done) return;
		offerUndo(`${t.tool} taken off`, {
			undo: async () =>
				(await act.restoreTool(done.value)) ? `${t.tool} put back` : null,
		});
	}

	return (
		<Card flush className="animate-in fade-in slide-in-from-bottom-1">
			<div className="flex flex-col gap-1 px-4 pt-3 pb-3">
				<div className="flex items-center gap-2">
					{several && (
						<span className="rounded-md bg-surface px-1.5 text-xs font-semibold tabular-nums text-muted-foreground">
							{place}
						</span>
					)}
					<div className="-mx-2 min-w-0 flex-1 text-base font-semibold">
						<ToolInput
							value={tool}
							productId={productId}
							products={index}
							disabled={!editable}
							onChange={(text, id) =>
								named.type({ tool: text, productId: bench ? productId : id })
							}
							onDone={(text, id) => {
								// A tool can't be blank; clearing it puts the old one back.
								if (!text.trim()) return named.revert();
								// Untouched, it already is what's there, so nothing is written.
								if (bench) {
									if (text !== t.tool) act.editTool(t.id, { tool: text });
								} else if (text !== t.tool || id !== t.productId)
									act.editTool(t.id, { tool: text, productId: id });
							}}
							className={cn(
								"h-8 rounded-lg px-2 focus-within:bg-surface",
								editable && "hover:bg-surface",
							)}
						/>
					</div>
					<span className="text-muted-foreground">
						<Totals minutes={c.minutes} total={c.total} />
					</span>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Print this tool's ticket"
						disabled={t.id < 0}
						onClick={() =>
							printPdf(
								`/labels/repairs/${r.id}?tool=${t.id}`,
								`R${r.id} ticket`,
							)
						}
					>
						<Printer />
					</Button>
					{editable && several && (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Take this tool off"
							onClick={() => void remove()}
						>
							<Trash2 />
						</Button>
					)}
				</div>
				<div className="-mx-2 text-muted-foreground">
					<NoteField
						id={`serial-${t.id}`}
						value={t.serial ?? ""}
						disabled={!editable}
						placeholder="Serial"
						onSave={(serial) => act.editTool(t.id, { serial })}
					/>
				</div>
				<textarea
					value={problem.value}
					disabled={!editable}
					onChange={(e) => problem.type(e.target.value)}
					onBlur={() => {
						const text = problem.save();
						if (text !== null) act.editTool(t.id, { problem: text });
					}}
					placeholder="What's wrong with it"
					rows={2}
					className="-mx-2 resize-none rounded-lg bg-transparent px-2 py-1 outline-none hover:bg-surface focus:bg-surface disabled:hover:bg-transparent"
				/>
			</div>
			<Charges
				d={d}
				act={act}
				toolId={t.id}
				index={index}
				editable={editable}
			/>
		</Card>
	);
}

// Labor and parts for the order as a whole, not one tool (a cleaning kit,
// a shop fee), and what was added to the draft in Shopify. Shown when it
// has something, or can be given something.
export function OtherCard({
	d,
	act,
	index,
	editable,
}: {
	d: Detail;
	act: Actions;
	index: IndexedProduct[];
	editable: boolean;
}) {
	const c = chargesOf(d, null);
	const others = d.draft.kind === "open" ? d.draft.others : [];
	if (!editable && c.labor.length + c.parts.length + others.length === 0)
		return null;
	return (
		<Folding
			open={c.labor.length + c.parts.length + others.length > 0}
			title="Not for one tool"
			aside={<Totals minutes={c.minutes} total={c.total} />}
		>
			<Charges
				d={d}
				act={act}
				toolId={null}
				index={index}
				editable={editable}
			/>
			<AddedInShopify d={d} />
		</Folding>
	);
}

// A card that stays one line until opened, so an empty one doesn't crowd
// the tools. Open from the start when it has something.
function Folding({
	open: initially,
	title,
	aside,
	children,
}: {
	open: boolean;
	title: string;
	aside: ReactNode;
	children: ReactNode;
}) {
	const [opened, setOpened] = useState(false);
	const open = initially || opened;
	if (!open)
		return (
			<button
				type="button"
				onClick={() => setOpened(true)}
				className="flex items-center gap-2 rounded-xl border border-dashed px-4 py-2.5 text-left text-muted-foreground hover:bg-card hover:text-foreground"
			>
				<Plus className="size-4" />
				{title}
			</button>
		);
	return (
		<Card flush title={title} aside={aside} className="animate-in fade-in">
			{children}
		</Card>
	);
}

// Another tool on the repair, typed or picked, added with Enter.
export function AddTool({
	act,
	index,
}: {
	act: Actions;
	index: IndexedProduct[];
}) {
	const [text, setText] = useState("");
	const [productId, setProductId] = useState<number | null>(null);
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (!text.trim()) return;
				void act.addTool({ tool: text.trim(), productId });
				setText("");
				setProductId(null);
			}}
			className="flex items-center gap-2 rounded-xl border border-dashed px-4 py-1 focus-within:border-ring focus-within:bg-card"
		>
			<Plus className="size-4 shrink-0 text-muted-foreground" />
			<ToolInput
				value={text}
				productId={productId}
				products={index}
				placeholder="Add another tool"
				onChange={(t, id) => {
					setText(t);
					setProductId(id);
				}}
				className="h-9 flex-1"
			/>
			{text.trim() && (
				<Button type="submit" size="sm" className="animate-in fade-in">
					Add
				</Button>
			)}
		</form>
	);
}
