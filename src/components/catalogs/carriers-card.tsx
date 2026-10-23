import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { type CatalogProduct, patchCatalog } from "#/components/catalogs/data";
import { Card } from "#/components/page";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { formatCount } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import {
	type CatalogDetail,
	listSuppliers,
	type SupplierRow,
	setSupplierCarries,
} from "#/server/purchasing";

type Carrier = CatalogDetail["carriers"][number];

// Who sells the catalog, and how many of its products each is the one
// reorder buys from. Carrying it means selling all of it, so a change
// reaches every product; each has Undo, and terms are kept either way.
export function CarriersCard({
	catalog,
	carriers,
	products,
}: {
	catalog: { id: number; name: string };
	carriers: Carrier[];
	products: CatalogProduct[];
}) {
	const bought = products.filter((p) => p.kind !== "bundle");
	const cheapestFor = (id: number) =>
		bought.filter((p) =>
			p.offers.some((o) => o.supplierId === id && o.cheapest),
		).length;
	const priced = (id: number) =>
		bought.filter((p) =>
			p.offers.some((o) => o.supplierId === id && o.cost !== null),
		).length;

	async function carry(s: Carrier, on: boolean) {
		const patch = (carried: boolean) =>
			patchCatalog(catalog.id, (d) => ({
				...d,
				carriers: carried
					? [...d.carriers.filter((c) => c.id !== s.id), s].sort((a, b) =>
							a.name.localeCompare(b.name),
						)
					: d.carriers.filter((c) => c.id !== s.id),
			}));
		const send = (carried: boolean) => () =>
			setSupplierCarries({
				data: { supplierId: s.id, catalogId: catalog.id, carried },
			});
		const r = await optimism.change({
			label: `${s.name} and ${catalog.name}`,
			patch: patch(on),
			send: send(on),
		});
		if (!r) return;
		offerUndo(
			on
				? `${s.name} sells ${catalog.name} now`
				: `${s.name} no longer sells ${catalog.name}`,
			{
				tone: "success",
				undo: async () => {
					const back = await optimism.change({
						label: `${s.name} and ${catalog.name}`,
						patch: patch(!on),
						send: send(!on),
					});
					return back && "Put back";
				},
			},
		);
	}

	return (
		<Card
			title="Sold by"
			aside={<AddCarrier carrying={carriers} onPick={(s) => carry(s, true)} />}
		>
			{carriers.length === 0 ? (
				<p className="text-warning-text">
					Nobody carries it, so reorder can't buy any of it.
				</p>
			) : (
				<ul className="-mx-1 flex flex-col gap-0.5">
					{carriers.map((s) => (
						<li
							key={s.id}
							className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-subtle"
						>
							<div className="min-w-0 flex-1">
								<Link
									to="/purchasing/suppliers/$id"
									params={{ id: String(s.id) }}
									className="block truncate font-medium hover:underline"
								>
									{s.name}
								</Link>
								<div className="text-xs text-muted-foreground tabular-nums">
									{carriers.length > 1 &&
										`Cheapest for ${formatCount(cheapestFor(s.id))} · `}
									{formatCount(priced(s.id))} of {formatCount(bought.length)}{" "}
									priced · {s.leadTimeDays}d lead
								</div>
							</div>
							<button
								type="button"
								aria-label={`${s.name} stops carrying ${catalog.name}`}
								onClick={() => carry(s, false)}
								className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-surface-strong hover:text-critical-text focus-visible:opacity-100"
							>
								<X className="size-4" />
							</button>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}

function AddCarrier({
	carrying,
	onPick,
}: {
	carrying: Carrier[];
	onPick: (s: Carrier) => void;
}) {
	const [open, setOpen] = useState(false);
	const [suppliers, setSuppliers] = useState<SupplierRow[] | null>(null);
	const others = suppliers?.filter(
		(s) => !carrying.some((c) => c.id === s.supplier.id),
	);
	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (o && suppliers === null) listSuppliers().then(setSuppliers);
			}}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-link hover:bg-subtle"
				>
					<Plus className="size-3.5" />
					Supplier
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-64 p-0" align="end">
				<Command>
					<CommandInput placeholder="Supplier" />
					<CommandList>
						<CommandEmpty>
							{suppliers === null ? "Loading…" : "No other supplier"}
						</CommandEmpty>
						{others?.map(({ supplier: s }) => (
							<CommandItem
								key={s.id}
								value={`${s.name} ${s.code}`}
								onSelect={() => {
									setOpen(false);
									onPick({
										id: s.id,
										name: s.name,
										leadTimeDays: s.leadTimeDays,
									});
								}}
							>
								<span className="flex-1 truncate">{s.name}</span>
								<span className="text-xs text-muted-foreground">{s.code}</span>
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
