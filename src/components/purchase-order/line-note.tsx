import { NotebookPen, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { ids, optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import {
	type PurchaseOrderDetail,
	setLineReceivingNote,
} from "#/server/purchasing";
import { lineName } from "./line-damage";
import { patchLines } from "./po-data";
import type { Line } from "./types";

// A line's receiving note can change only while the PO is on order or
// closed, as setReceivingNote allows.
export const notable = (status: PurchaseOrderDetail["order"]["status"]) =>
	status === "sent" || status === "closed";

// A line's receiving note, under it as its damage is. Opens the note to edit
// when it can still change.
export function NoteRow({
	note,
	columns,
	onOpen,
	onContextMenu,
}: {
	note: string;
	columns: number;
	// null when the note can't change any more.
	onOpen: (() => void) | null;
	onContextMenu: () => void;
}) {
	const body = (
		<div className="flex min-w-0 flex-1 items-start gap-3 border-l-2 border-warning-text/40 pl-3">
			<NotebookPen className="mt-0.5 size-4 shrink-0 text-warning-text" />
			<span className="min-w-0 text-sm whitespace-pre-wrap text-warning-text">
				{note}
			</span>
		</div>
	);
	const look =
		"flex w-full items-center gap-3 bg-warning-surface/40 py-1.5 pr-4 pl-10 text-left";
	return (
		<tr onContextMenu={onContextMenu}>
			<td colSpan={columns} className="p-0 whitespace-normal!">
				{onOpen ? (
					<button
						type="button"
						onClick={onOpen}
						aria-label={`Edit the note: ${note}`}
						className={`${look} cursor-pointer hover:bg-warning-surface/70 focus-visible:bg-warning-surface/70 focus-visible:outline-none`}
					>
						{body}
					</button>
				) : (
					<div className={look}>{body}</div>
				)}
			</td>
		</tr>
	);
}

// Writes, changes, or takes off a line's receiving note. Blank saves as no
// note. Closing with changes unsaved asks first.
export function NoteDialog({
	line,
	purchaseOrderId,
	onClose,
}: {
	line: Line;
	purchaseOrderId: number;
	onClose: () => void;
}) {
	const note = line.receivingNote;
	const [text, setText] = useState(note ?? "");
	const next = text.trim() || null;
	const changed = next !== note;

	function close() {
		if (changed && !confirm("Throw away this note?")) return;
		onClose();
	}

	function save(value: string | null) {
		onClose();
		void saveNote(line, value, purchaseOrderId);
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		if (changed) save(next);
	}

	return (
		<Dialog open onOpenChange={(open) => !open && close()}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={submit} className="flex flex-col gap-5">
					<DialogHeader>
						<DialogTitle>{note === null ? "Add a note" : "Note"}</DialogTitle>
						<DialogDescription>
							{lineName(line)}. Shown on this line and on the receive page;
							never sent to the supplier.
						</DialogDescription>
					</DialogHeader>
					<textarea
						autoFocus
						onFocus={(e) =>
							e.currentTarget.setSelectionRange(
								e.currentTarget.value.length,
								e.currentTarget.value.length,
							)
						}
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							// Enter adds a line; Ctrl or Cmd with it saves.
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
								e.currentTarget.form?.requestSubmit();
						}}
						rows={4}
						placeholder="e.g. 2 crushed, kept"
						aria-label={`Note for ${lineName(line)}`}
						className="w-full resize-none rounded-md border bg-transparent p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
					/>
					<DialogFooter>
						{note !== null && next !== null && (
							<Button
								type="button"
								variant="ghost"
								className="mr-auto"
								onClick={() => save(null)}
							>
								<Trash2 />
								Remove note
							</Button>
						)}
						<Button type="button" variant="outline" onClick={close}>
							Cancel
						</Button>
						<Button type="submit" disabled={!changed}>
							{!changed
								? "No changes"
								: next === null
									? "Remove note"
									: "Save note"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// Sets the note at once, with Undo once the server has it.
async function saveNote(
	line: Line,
	note: string | null,
	purchaseOrderId: number,
) {
	const was = line.receivingNote;
	const change = (value: string | null) =>
		optimism.change({
			label: `Note on ${line.sku}`,
			patch: patchLines(
				purchaseOrderId,
				(l) => ids.same(l.id, line.id),
				(l) => ({ ...l, receivingNote: value }),
			),
			send: () =>
				setLineReceivingNote({
					data: { lineId: ids.server(line.id), note: value },
				}),
		});
	const r = await change(note);
	if (!r) return;
	offerUndo(
		note === null ? `Removed the note on ${line.sku}` : `Noted ${line.sku}`,
		{
			undo: async () => {
				const u = await change(was);
				return u && `Put the note on ${line.sku} back`;
			},
		},
	);
}
