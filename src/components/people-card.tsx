import { Pencil, Trash2, Wrench } from "lucide-react";
import { useState } from "react";
import { Card } from "#/components/page";
import { PersonChip } from "#/components/repairs/person-chip";
import { IconAction, Row } from "#/components/rows";
import { Button } from "#/components/ui/button";
import { ids, optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { Person } from "#/repairs/people";
import {
	addPersonNow,
	editPersonNow,
	removePersonNow,
	restorePersonNow,
} from "#/server/people";

// People in the shop, apart from the shared sign-in. Technicians can be
// given repairs, shown as their chip on the board.

export const peopleData = optimistic<Person[]>("people");

const sorted = (list: Person[]) =>
	[...list].sort((a, b) =>
		a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
	);

export function PeopleCard({ people }: { people: Person[] }) {
	const [adding, setAdding] = useState(false);
	const [renaming, setRenaming] = useState<number | null>(null);
	const set = (apply: (list: Person[]) => Person[]) =>
		peopleData.patch("all", (l) => sorted(apply(l)));

	function add(name: string) {
		setAdding(false);
		const id = ids.provisional();
		void optimism.change({
			label: `Adding ${name}`,
			patch: set((l) => [
				...l,
				{ id, name: name.trim(), technician: true, open: 0 },
			]),
			send: async () => {
				const r = await addPersonNow({ data: { name, technician: true } });
				ids.confirm(id, r.id);
				return r;
			},
		});
	}

	function edit(p: Person, change: { name?: string; technician?: boolean }) {
		setRenaming(null);
		void optimism.change({
			label: p.name,
			patch: set((l) =>
				l.map((x) => (ids.same(x.id, p.id) ? { ...x, ...change } : x)),
			),
			send: () => editPersonNow({ data: { id: ids.server(p.id), ...change } }),
		});
	}

	async function remove(p: Person) {
		const r = await optimism.change({
			label: `Removing ${p.name}`,
			patch: set((l) => l.filter((x) => !ids.same(x.id, p.id))),
			send: () => removePersonNow({ data: { id: ids.server(p.id) } }),
		});
		if (!r) return;
		offerUndo(`Removed ${p.name}`, {
			undo: async () => {
				const back = await optimism.change({
					label: `Bringing back ${p.name}`,
					patch: set((l) => [...l, p]),
					send: () => restorePersonNow({ data: { id: ids.server(p.id) } }),
				});
				return back && `${p.name} is back`;
			},
		});
	}

	return (
		<Card
			title="People"
			flush
			aside={
				!adding && (
					<Button size="sm" variant="outline" onClick={() => setAdding(true)}>
						Add person
					</Button>
				)
			}
		>
			{adding && (
				<div className="px-4 pb-3">
					<NameForm initial="" onSave={add} onCancel={() => setAdding(false)} />
				</div>
			)}
			<ul>
				{people.map((p) =>
					renaming === p.id ? (
						<Row key={p.id}>
							<NameForm
								initial={p.name}
								onSave={(name) => edit(p, { name })}
								onCancel={() => setRenaming(null)}
							/>
						</Row>
					) : (
						<Row
							key={p.id}
							actions={
								<>
									<IconAction
										icon={Pencil}
										label="Rename"
										onClick={() => setRenaming(p.id)}
									/>
									<IconAction
										icon={Trash2}
										label="Remove"
										onClick={() => remove(p)}
									/>
								</>
							}
						>
							<PersonChip id={p.id} name={p.name} active={p.technician} />
							<span className="flex-1 text-muted-foreground">
								{p.open > 0 &&
									`${p.open} ${p.open === 1 ? "repair" : "repairs"} open`}
							</span>
							<button
								type="button"
								aria-pressed={p.technician}
								onClick={() => edit(p, { technician: !p.technician })}
								className={cn(
									"flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold transition-colors",
									p.technician
										? "bg-info-fill text-info-text"
										: "bg-surface-strong text-muted-foreground hover:text-foreground",
								)}
							>
								<Wrench className="size-3.5" />
								Technician
							</button>
						</Row>
					),
				)}
			</ul>
		</Card>
	);
}

function NameForm({
	initial,
	onSave,
	onCancel,
}: {
	initial: string;
	onSave: (name: string) => void;
	onCancel: () => void;
}) {
	const [name, setName] = useState(initial);
	return (
		<form
			className="flex w-full items-center gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (name.trim()) onSave(name);
			}}
			onKeyDown={(e) => e.key === "Escape" && onCancel()}
		>
			<input
				value={name}
				// biome-ignore lint/a11y/noAutofocus: opened to type a name
				autoFocus
				placeholder="Name"
				onChange={(e) => setName(e.target.value)}
				className="h-8 flex-1 rounded-lg border border-input bg-white px-2 outline-none focus:border-ring"
			/>
			<Button type="submit" size="sm" disabled={name.trim() === ""}>
				Save
			</Button>
			<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
				Cancel
			</Button>
		</form>
	);
}
