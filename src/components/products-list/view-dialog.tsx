import { type FormEvent, useState } from "react";
import { patchViews } from "#/components/products-list/optimistic";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import type { Filter } from "#/products/search";
import type { SortText, View } from "#/products/views";
import { deleteView, saveView } from "#/server/views";

// Names a new view, or renames or deletes an existing one.
export function ViewDialog({
	view,
	search,
	onClose,
	onSaved,
	onDeleted,
}: {
	view: View | null;
	search: { filters: Filter[]; sort: SortText };
	onClose: () => void;
	onSaved: (id: number) => void;
	onDeleted: () => void;
}) {
	const [name, setName] = useState(view?.name ?? "");
	const [saving, setSaving] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (view) {
			// A rename shows at once, so the dialog closes as it's made. If it
			// fails, the engine says why and the old name comes back.
			const { id } = view;
			const next = { ...view, name };
			void optimism.change({
				label: `Renaming “${view.name}”`,
				patch: patchViews((views) =>
					views.map((v) => (v.id === id ? { ...v, name: name.trim() } : v)),
				),
				send: () => saveView({ data: next }),
			});
			onSaved(id);
			return;
		}
		// A new view's id comes from the server, so the dialog waits for it.
		setSaving(true);
		const r = await optimism.change({
			send: () => saveView({ data: { name, ...search } }),
		});
		setSaving(false);
		if (r) onSaved(r.value.id);
	}

	function remove() {
		if (!view) return;
		const gone = view;
		// Off the tabs at once. Undo brings it back as a new view, since the
		// server gives it a new id.
		void optimism
			.change({
				label: `Deleting “${gone.name}”`,
				patch: patchViews((views) => views.filter((v) => v.id !== gone.id)),
				send: () => deleteView({ data: { id: gone.id } }),
			})
			.then((r) => {
				if (!r) return;
				offerUndo(`Deleted “${gone.name}”`, {
					undo: async () => {
						const { id: _, ...rest } = gone;
						const back = await optimism.change({
							send: () => saveView({ data: rest }),
						});
						return back && `“${gone.name}” is back`;
					},
				});
			});
		onDeleted();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-sm">
				<form onSubmit={submit} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>{view ? "Edit view" : "Save view"}</DialogTitle>
					</DialogHeader>
					<input
						autoFocus
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Name, e.g. Low stock A items"
						className="h-9 rounded-lg border border-input px-3 outline-none focus:border-ring focus:ring-1 focus:ring-ring"
					/>
					<DialogFooter className="sm:justify-between">
						{view ? (
							<Button type="button" variant="ghost" onClick={remove}>
								Delete view
							</Button>
						) : (
							<span />
						)}
						<Button type="submit" disabled={!name.trim() || saving}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
