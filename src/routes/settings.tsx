import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { DevicesCard, devicesData } from "#/components/devices-card";
import { LabelPrintingCard } from "#/components/label-printing-card";
import { Badge, Card, Page } from "#/components/page";
import { FieldsCard, ListCard, ListSkeleton } from "#/components/skeleton";
import { MinStockForm } from "#/components/stock-range-form";
import { TokensCard, tokensData } from "#/components/tokens-card";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { channelNames } from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import { listDevices, listTokens } from "#/server/auth";
import {
	getDefaultMinStock,
	listLocations,
	listStores,
	saveDefaultMinStock,
	setPrimaryStore,
} from "#/server/catalog";
import {
	addPurchaseUnit,
	deletePurchaseUnit,
	listPurchaseUnits,
	renamePurchaseUnit,
} from "#/server/purchasing";
import {
	deletePackage,
	listPackages,
	savePackage,
	updatePackage,
} from "#/server/shipping";

export const Route = createFileRoute("/settings")({
	loader: async () => {
		const [locations, stores, boxes, units, devices, tokens, minStock] =
			await Promise.all([
				listLocations(),
				listStores(),
				listPackages(),
				listPurchaseUnits(),
				listDevices(),
				listTokens(),
				getDefaultMinStock(),
			]);
		return { locations, stores, boxes, units, devices, tokens, minStock };
	},
	component: Settings,
	pendingComponent: () => (
		<ListSkeleton title="Settings" width="narrow">
			<ListCard title="Sales channels" rows={3} />
			<ListCard title="Locations" rows={3} />
			<FieldsCard title="Stock range" />
		</ListSkeleton>
	),
});

const channels = Object.entries(channelNames).map(([id, name]) => ({
	id,
	name,
}));

// What changes on this page shows at once from these lists.
const storesData = optimistic<Store[]>("stores");
const boxesData = optimistic<Box[]>("boxes");
const unitsData = optimistic<Unit[]>("units");

function Settings() {
	const loaded = Route.useLoaderData();
	const { locations, minStock } = loaded;
	const stores = storesData.useData("all", loaded.stores);
	const boxes = boxesData.useData("all", loaded.boxes);
	const units = unitsData.useData("all", loaded.units);
	const devices = devicesData.useData("all", loaded.devices);
	const tokens = tokensData.useData("all", loaded.tokens);
	return (
		<Page title="Settings" width="narrow">
			<Card title="Sales channels" flush>
				{/* Fixed columns, so the primary controls line up whatever the
				    store names' lengths. */}
				<ul>
					{channels.map((c) => {
						const connected = stores.filter((s) => s.channel === c.id);
						return (connected.length > 0 ? connected : [null]).map((s) => (
							<li
								key={s?.id ?? c.id}
								className="grid grid-cols-[8rem_minmax(0,1fr)_8.5rem] items-center gap-3 border-t px-4 py-3 first:border-t-0"
							>
								<span className="font-medium">{c.name}</span>
								<span className="truncate">
									{s ? (
										<Badge tone="success">{s.name}</Badge>
									) : (
										<Badge>Not connected</Badge>
									)}
								</span>
								<span className="flex justify-end">
									{s && <PrimaryToggle store={s} />}
								</span>
							</li>
						));
					})}
				</ul>
				<p className="border-t px-4 py-3 text-muted-foreground">
					The primary store's new SKUs become products. Other stores only match.
				</p>
			</Card>
			<Card title="Locations" flush>
				<ul>
					{locations.map((l) => (
						<Item key={l.id} label={l.name}>
							<span className="text-muted-foreground">
								{l.kind === "fba" ? "Amazon's warehouse" : "Ours"}
							</span>
						</Item>
					))}
				</ul>
			</Card>
			<DevicesCard devices={devices} />
			<TokensCard tokens={tokens} />
			<Boxes boxes={boxes} />
			<Units units={units} />
			<Card title="Stock range">
				<MinStockForm
					value={minStock}
					onSave={(min) => saveDefaultMinStock({ data: { min } })}
				/>
				<p className="mt-2 text-muted-foreground">
					Default for products without their own. Max follows sales, lead time,
					cover, and safety stock; at least 5.
				</p>
			</Card>
			<LabelPrintingCard />
		</Page>
	);
}

function Item({ label, children }: { label: string; children: ReactNode }) {
	return (
		<li className="flex items-center justify-between border-t px-4 py-3 first:border-t-0">
			<span className="font-medium">{label}</span>
			{children}
		</li>
	);
}

type Box = Awaited<ReturnType<typeof listPackages>>[number];
const inches = (mm: number) => Math.round((mm / 25.4) * 10) / 10;
const ounces = (g: number) => Math.round((g / 28.349523125) * 10) / 10;

// The boxes quick ship knows by pin. Typing a box's pin fills in its size
// and empty weight. Any box can be edited, pin included.
function Boxes({ boxes }: { boxes: Box[] }) {
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<number | null>(null);
	const [saving, setSaving] = useState(false);

	// A new box's pin comes from the server, so the form waits for its answer.
	async function add(values: BoxValues) {
		setSaving(true);
		const r = await optimism.change({
			send: () => savePackage({ data: values }),
		});
		setSaving(false);
		if (!r) return;
		toast.success(`Saved ${r.value.name} as pin ${r.value.pin}`);
		setAdding(false);
	}

	// An edit shows at once; if the server refuses it, the box goes back.
	async function edit(box: Box, values: BoxValues) {
		setEditing(null);
		const r = await optimism.change({
			label: `Editing ${box.name}`,
			patch: boxesData.patch("all", (list) =>
				list
					.map((b) => (b.id === box.id ? savedBox(b, values) : b))
					.sort((x, y) => x.pin - y.pin),
			),
			send: () =>
				updatePackage({
					data: { ...values, id: box.id, pin: values.pin ?? box.pin },
				}),
		});
		if (r) toast.success(`Saved ${r.value.name} as pin ${r.value.pin}`);
	}

	async function remove(box: Box) {
		const r = await optimism.change({
			label: `Removing ${box.name}`,
			patch: boxesData.patch("all", (list) =>
				list.filter((b) => b.id !== box.id),
			),
			send: () => deletePackage({ data: { id: box.id } }),
		});
		if (r) toast.success(`Removed ${box.name}`);
	}

	return (
		<Card
			title="Boxes"
			flush
			aside={
				!adding && (
					<Button size="sm" variant="outline" onClick={() => setAdding(true)}>
						Add box
					</Button>
				)
			}
		>
			{boxes.length === 0 && !adding && (
				<p className="px-4 py-3 text-muted-foreground">
					Type a box's pin in quick ship (Ctrl+Space).
				</p>
			)}
			<ul>
				{boxes.map((b) =>
					editing === b.id ? (
						<li key={b.id} className="border-t first:border-t-0">
							<BoxForm
								box={b}
								onSave={(values) => edit(b, values)}
								onCancel={() => setEditing(null)}
							/>
						</li>
					) : (
						<li
							key={b.id}
							className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0"
						>
							<span className="w-12 font-mono text-base font-bold">
								{b.pin}
							</span>
							<span className="flex-1 font-medium">{b.name}</span>
							<span className="text-muted-foreground tabular-nums">
								{inches(b.lengthMm)} × {inches(b.widthMm)} ×{" "}
								{inches(b.heightMm)} in
							</span>
							<span className="w-20 text-right text-muted-foreground tabular-nums">
								{b.weightGrams ? `${ounces(b.weightGrams)} oz` : "No weight"}
							</span>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setEditing(b.id)}
							>
								Edit
							</Button>
							<Button size="sm" variant="ghost" onClick={() => remove(b)}>
								Remove
							</Button>
						</li>
					),
				)}
			</ul>
			{adding && (
				<div className="border-t">
					<BoxForm
						saving={saving}
						onSave={(values) => add(values)}
						onCancel={() => setAdding(false)}
					/>
				</div>
			)}
		</Card>
	);
}

type BoxValues = {
	name: string;
	lengthIn: number;
	widthIn: number;
	heightIn: number;
	weightOz: number;
	pin?: number;
};

const MM_PER_INCH = 25.4;
const GRAMS_PER_OUNCE = 28.349523125;

// A box as the server keeps it (see src/shipping/boxes.ts), so an edit shows
// what will stay.
function savedBox(box: Box, values: BoxValues): Box {
	return {
		...box,
		name: values.name.trim(),
		lengthMm: Math.round(values.lengthIn * MM_PER_INCH),
		widthMm: Math.round(values.widthIn * MM_PER_INCH),
		heightMm: Math.round(values.heightIn * MM_PER_INCH),
		weightGrams: Math.round(values.weightOz * GRAMS_PER_OUNCE),
		pin: values.pin ?? box.pin,
	};
}

// Adding a new box, or editing one (filled in with its current values).
// Escape cancels.
function BoxForm({
	box,
	saving,
	onSave,
	onCancel,
}: {
	box?: Box;
	saving?: boolean;
	onSave: (values: BoxValues) => void;
	onCancel: () => void;
}) {
	function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const f = new FormData(e.currentTarget);
		const n = (key: string) => Number(f.get(key));
		onSave({
			name: String(f.get("name")),
			lengthIn: n("length"),
			widthIn: n("width"),
			heightIn: n("height"),
			weightOz: n("weight") || 0,
			...(f.get("pin") ? { pin: n("pin") } : {}),
		});
	}

	const field =
		"h-9 rounded-lg border border-input px-2 tabular-nums outline-none focus:border-ring";
	const sides = {
		length: box && inches(box.lengthMm),
		width: box && inches(box.widthMm),
		height: box && inches(box.heightMm),
	};
	return (
		<form
			onSubmit={submit}
			onKeyDown={(e) => e.key === "Escape" && onCancel()}
			className="flex flex-wrap items-end gap-2 px-4 py-3"
		>
			<label className="flex flex-1 flex-col gap-1">
				<span className="text-muted-foreground">Name</span>
				<input
					name="name"
					required
					// biome-ignore lint/a11y/noAutofocus: opened to type this
					autoFocus
					defaultValue={box?.name}
					className={field}
				/>
			</label>
			{(["length", "width", "height"] as const).map((d) => (
				<label key={d} className="flex w-16 flex-col gap-1">
					<span className="text-muted-foreground capitalize">{d}</span>
					<input
						name={d}
						required
						inputMode="decimal"
						placeholder="in"
						defaultValue={sides[d]}
						className={field}
					/>
				</label>
			))}
			<label className="flex w-20 flex-col gap-1">
				<span className="text-muted-foreground">Empty wt</span>
				<input
					name="weight"
					inputMode="decimal"
					placeholder="oz"
					defaultValue={box?.weightGrams ? ounces(box.weightGrams) : undefined}
					className={field}
				/>
			</label>
			<label className="flex w-16 flex-col gap-1">
				<span className="text-muted-foreground">Pin</span>
				<input
					name="pin"
					inputMode="numeric"
					maxLength={3}
					placeholder="auto"
					defaultValue={box?.pin}
					required={!!box}
					className={field}
				/>
			</label>
			<Button type="submit" size="sm" disabled={saving}>
				{saving ? "Saving…" : "Save"}
			</Button>
			<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
				Cancel
			</Button>
		</form>
	);
}

type Store = Awaited<ReturnType<typeof listStores>>[number];

// Which store is primary shows at once. The products its listings make come
// with the reload, and the toast says how many.
function PrimaryToggle({ store }: { store: Store }) {
	async function set(id: number | null) {
		const r = await optimism.change({
			label:
				id === null
					? "Clearing the primary store"
					: `Making ${store.name} primary`,
			patch: storesData.patch("all", (list) =>
				list.map((s) => ({ ...s, primary: s.id === id })),
			),
			send: () => setPrimaryStore({ data: { id } }),
		});
		if (!r) return;
		const { created, skipped } = r.value;
		toast.success(
			id === null
				? "No primary store"
				: `${store.name} is primary. ${created === 1 ? "1 product" : `${created} products`} created.`,
			skipped.length > 0
				? {
						description: `${skipped.length} left on Listings: ${skipped.slice(0, 3).join("; ")}`,
					}
				: undefined,
		);
	}

	return store.primary ? (
		// Same box as the Make primary button, so both line up.
		<Tip content="Unset primary">
			<Button size="sm" variant="ghost" onClick={() => set(null)}>
				<Badge tone="info">Primary</Badge>
			</Button>
		</Tip>
	) : (
		<Button size="sm" variant="ghost" onClick={() => set(store.id)}>
			Make primary
		</Button>
	);
}

type Unit = Awaited<ReturnType<typeof listPurchaseUnits>>[number];

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
function Units({ units }: { units: Unit[] }) {
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
		<div id="units">
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
				<ul>
					{units.map((u) =>
						renaming === u.name ? (
							<li key={u.name} className="border-t first:border-t-0">
								<UnitNameForm
									initial={u.name}
									onSave={(to) => rename(u.name, to)}
									onCancel={() => setRenaming(null)}
								/>
							</li>
						) : (
							<li
								key={u.name}
								className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0"
							>
								<span className="flex-1 font-medium">{u.name}</span>
								<span className="text-muted-foreground">
									{u.name === "EACH"
										? "One of the product"
										: u.products === 0
											? "Not used"
											: `${u.products} ${u.products === 1 ? "product" : "products"}`}
								</span>
								{u.name !== "EACH" && (
									<>
										<Button
											size="sm"
											variant="ghost"
											onClick={() => setRenaming(u.name)}
										>
											Rename
										</Button>
										<Tip
											content={
												u.products > 0
													? `Used by ${u.products} ${u.products === 1 ? "product" : "products"}`
													: undefined
											}
										>
											<Button
												size="sm"
												variant="ghost"
												disabled={u.products > 0}
												onClick={() => remove(u)}
											>
												Remove
											</Button>
										</Tip>
									</>
								)}
							</li>
						),
					)}
				</ul>
				{adding && (
					<div className="border-t">
						<UnitNameForm
							initial=""
							onSave={(name) => add(name)}
							onCancel={() => setAdding(false)}
						/>
					</div>
				)}
			</Card>
		</div>
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
			className="flex items-center gap-2 px-4 py-3"
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
