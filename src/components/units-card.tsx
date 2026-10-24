import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Card } from "#/components/page";
import { ActionSlot, IconAction, Row } from "#/components/rows";
import { Button } from "#/components/ui/button";
import { optimism, optimistic } from "#/lib/optimism";
import {
	addPurchaseUnit,
	deletePurchaseUnit,
	type listPurchaseUnits,
	renamePurchaseUnit,
} from "#/server/purchasing";

export type Unit = Awaited<ReturnType<typeof listPurchaseUnits>>[number];

export const unitsData = optimistic<Unit[]>("units");

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

// The unit's name as the server keeps it (see unitName).
const unitName = (raw: string) => raw.trim().replace(/\s+/g, " ").toUpperCase();

// EACH first, then by name, as the server lists them.
const sortUnits = (list: Unit[]) =>
	[...list].sort((a, b) =>
		a.name === "EACH"
			? -1
			: b.name === "EACH"
				? 1
				: a.name.localeCompare(b.name),
	);

// What suppliers sell in, offered when setting a product's MOQ / UOM. A
// rename carries over to every product in that unit; a unit in use can't be
// removed.
export function UnitsCard({ units }: { units: Unit[] }) {
	const [renaming, setRenaming] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);

	// The form closes at once. If the server refuses (a name already taken,
	// say), the list goes back and the engine says why.
	async function rename(from: string, to: string) {
		setRenaming(null);
		const r = await optimism.change({
			label: `Renaming ${from}`,
			patch: unitsData.patch("all", (list) =>
				sortUnits(
					list.map((u) => (u.name === from ? { ...u, name: unitName(to) } : u)),
				),
			),
			send: () => renamePurchaseUnit({ data: { from, to } }),
		});
		if (r) toast.success(`Renamed ${from}`);
	}

	async function add(raw: string) {
		setAdding(false);
		const name = unitName(raw);
		const r = await optimism.change({
			label: `Adding ${name}`,
			patch: unitsData.patch("all", (list) =>
				sortUnits([...list, { name, products: 0 }]),
			),
			send: () => addPurchaseUnit({ data: { name: raw } }),
		});
		if (r) toast.success(`Added ${name}`);
	}

	async function remove(u: Unit) {
		const r = await optimism.change({
			label: `Removing ${u.name}`,
			patch: unitsData.patch("all", (list) =>
				list.filter((x) => x.name !== u.name),
			),
			send: () => deletePurchaseUnit({ data: { name: u.name } }),
		});
		if (r) toast.success(`Removed ${u.name}`);
	}

	return (
		<Card
			title="Purchase units"
			flush
			aside={
				!adding && (
					<Button size="sm" variant="outline" onClick={() => setAdding(true)}>
						Add unit
					</Button>
				)
			}
		>
			{adding && (
				<div className="px-4 pb-3">
					<UnitNameForm
						initial=""
						onSave={(name) => add(name)}
						onCancel={() => setAdding(false)}
					/>
				</div>
			)}
			<ul>
				{units.map((u) =>
					renaming === u.name ? (
						<Row key={u.name}>
							<UnitNameForm
								initial={u.name}
								onSave={(to) => rename(u.name, to)}
								onCancel={() => setRenaming(null)}
							/>
						</Row>
					) : (
						<Row
							key={u.name}
							actions={
								u.name === "EACH" ? (
									<>
										<ActionSlot />
										<ActionSlot />
									</>
								) : (
									<>
										<IconAction
											icon={Pencil}
											label="Rename"
											onClick={() => setRenaming(u.name)}
										/>
										<IconAction
											icon={Trash2}
											label="Remove"
											tip={
												u.products > 0
													? `Used by ${plural(u.products, "product")}`
													: undefined
											}
											disabled={u.products > 0}
											onClick={() => remove(u)}
										/>
									</>
								)
							}
						>
							<span className="flex-1 font-medium">{u.name}</span>
							<span className="text-muted-foreground">
								{u.name === "EACH"
									? "Built in"
									: u.products === 0
										? "Not used"
										: plural(u.products, "product")}
							</span>
						</Row>
					),
				)}
			</ul>
		</Card>
	);
}

function UnitNameForm({
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
				onSave(name);
			}}
			onKeyDown={(e) => e.key === "Escape" && onCancel()}
		>
			<input
				value={name}
				// biome-ignore lint/a11y/noAutofocus: opened to type a name
				autoFocus
				placeholder="e.g. CASE, BAG, ROLL"
				onChange={(e) => setName(e.target.value)}
				className="h-8 flex-1 rounded-lg border border-input bg-white px-2 uppercase outline-none focus:border-ring"
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
