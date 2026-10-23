import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
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
import { createCatalog, deleteCatalog } from "#/server/purchasing";

export const fieldClass =
	"w-full rounded-lg border border-input bg-white px-2.5 py-1.5 outline-none focus:border-ring";

// Names a new catalog and opens it, since adding its products and
// suppliers comes next. Undo deletes it while it's still empty.
export function NewCatalogDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const navigate = useNavigate();
	const [busy, setBusy] = useState(false);

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const f = new FormData(e.currentTarget);
		const name = String(f.get("name") ?? "").trim();
		const description = String(f.get("description") ?? "").trim() || null;
		setBusy(true);
		const r = await optimism.change({
			send: () => createCatalog({ data: { name, description } }),
		});
		setBusy(false);
		if (!r) return;
		onOpenChange(false);
		navigate({
			to: "/purchasing/catalogs/$id",
			params: { id: String(r.value) },
		});
		offerUndo(`Made ${name}`, {
			tone: "success",
			undo: async () => {
				const back = await optimism.change({
					send: () => deleteCatalog({ data: { id: r.value } }),
				});
				if (!back) return null;
				navigate({ to: "/purchasing/catalogs" });
				return `Deleted ${name}`;
			},
		});
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New catalog</DialogTitle>
				</DialogHeader>
				<form
					// Fresh fields each time it opens.
					key={String(open)}
					onSubmit={submit}
					className="flex flex-col gap-3"
				>
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">Name</span>
						<input
							name="name"
							required
							autoFocus
							placeholder="e.g. Columbia"
							className={fieldClass}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">Description</span>
						<textarea
							name="description"
							rows={2}
							placeholder="What's in it, in words you'd search for"
							className={fieldClass}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									e.currentTarget.form?.requestSubmit();
								}
							}}
						/>
					</label>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" size="sm" disabled={busy}>
							Make catalog
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
