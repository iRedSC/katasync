import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { PageBody, PageHeader } from "#/components/page";
import { MovementTable } from "#/components/product";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { adjustStock, listLocations, listMovements } from "#/server/catalog";

export const Route = createFileRoute("/stock")({
	loader: async () => ({
		movements: await listMovements(),
		locations: await listLocations(),
	}),
	component: Stock,
});

function Stock() {
	const { movements, locations } = Route.useLoaderData();
	return (
		<>
			<PageHeader
				title="Stock movements"
				description="Every change to stock, newest first. Corrections are new movements, never edits."
				actions={
					<AdjustDialog
						locations={locations.filter((l) => l.kind === "owned")}
					/>
				}
			/>
			<PageBody>
				<div className="rounded-lg border px-2">
					<MovementTable rows={movements} />
				</div>
			</PageBody>
		</>
	);
}

function AdjustDialog({
	locations,
}: {
	locations: { id: number; name: string }[];
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [locationId, setLocationId] = useState(String(locations[0]?.id ?? ""));

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		setError(null);
		try {
			await adjustStock({
				data: {
					sku: String(form.get("sku")).trim(),
					locationId: Number(locationId),
					delta: Number(form.get("delta")),
					note: String(form.get("note")).trim(),
				},
			});
			setOpen(false);
			await router.invalidate();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button size="sm">
					<Plus />
					Adjust stock
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form onSubmit={submit} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>Adjust stock</DialogTitle>
						<DialogDescription>
							For counts and corrections. Use a negative number to remove units.
						</DialogDescription>
					</DialogHeader>
					<Input name="sku" placeholder="SKU" required autoFocus />
					<div className="flex gap-2">
						<Select value={locationId} onValueChange={setLocationId}>
							<SelectTrigger className="flex-1">
								<SelectValue placeholder="Location" />
							</SelectTrigger>
							<SelectContent>
								{locations.map((l) => (
									<SelectItem key={l.id} value={String(l.id)}>
										{l.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Input
							name="delta"
							type="number"
							step={1}
							placeholder="Change, e.g. -2"
							required
							className="w-40"
						/>
					</div>
					<Input name="note" placeholder="Why, e.g. cycle count" required />
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="submit">Record adjustment</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
