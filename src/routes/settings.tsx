import { createFileRoute } from "@tanstack/react-router";
import { Pencil, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import {
	ConnectionsCard,
	connectionsData,
} from "#/components/connections-card";
import { DevicesCard, devicesData } from "#/components/devices-card";
import {
	EmailTemplatesCard,
	templatesData,
} from "#/components/email-templates-card";
import { LabelPrintingCard } from "#/components/label-printing-card";
import { Badge, Card, Page } from "#/components/page";
import { PullNow } from "#/components/pull-now";
import { ActionSlot, IconAction, Row } from "#/components/rows";
import { ListSkeleton } from "#/components/skeleton";
import { StockPushCard } from "#/components/stock-push-card";
import { MinStockForm, ReserveForm } from "#/components/stock-range-form";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { channelNames } from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import { listConnections, listDevices } from "#/server/auth";
import {
	getDefaultMinStock,
	getRetailReserve,
	listLocations,
	listStores,
	saveDefaultMinStock,
	savePosLocation,
	saveRetailReserve,
	setPrimaryStore,
} from "#/server/catalog";
import { listEmailTemplates } from "#/server/email-templates";
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
import { listStockPush } from "#/server/stock-push";
import { boxLabel, boxSize } from "#/shipping/box-filter";

export const Route = createFileRoute("/settings")({
	loader: async () => {
		const [
			locations,
			stores,
			stockPush,
			boxes,
			units,
			devices,
			connections,
			minStock,
			reserve,
			templates,
		] = await Promise.all([
			listLocations(),
			listStores(),
			listStockPush(),
			listPackages(),
			listPurchaseUnits(),
			listDevices(),
			listConnections(),
			getDefaultMinStock(),
			getRetailReserve(),
			listEmailTemplates(),
		]);
		return {
			locations,
			stores,
			stockPush,
			boxes,
			units,
			devices,
			connections,
			minStock,
			reserve,
			templates,
		};
	},
	component: Settings,
	pendingComponent: () => <ListSkeleton title="Settings" />,
});

const channels = Object.entries(channelNames).map(([id, name]) => ({
	id,
	name,
}));

// What changes on this page shows at once from these lists.
const storesData = optimistic<Store[]>("stores");
const locationsData = optimistic<Location[]>("locations");
const boxesData = optimistic<Box[]>("boxes");
const unitsData = optimistic<Unit[]>("units");

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

function Settings() {
	const loaded = Route.useLoaderData();
	const { minStock, reserve } = loaded;
	const locations = locationsData.useData("all", loaded.locations);
	const retail = locations.find((l) => l.kind === "retail");
	const stores = storesData.useData("all", loaded.stores);
	const boxes = boxesData.useData("all", loaded.boxes);
	const units = unitsData.useData("all", loaded.units);
	const devices = devicesData.useData("all", loaded.devices);
	const apps = connectionsData.useData("all", loaded.connections.apps);
	const templates = templatesData.useData("all", loaded.templates);
	// Two columns of cards sized to what they hold: stores and shipping on
	// the left, purchasing and access on the right.
	return (
		<Page title="Settings">
			<div className="grid items-start gap-4 lg:grid-cols-2">
				<div className="flex flex-col gap-4">
					<Channels stores={stores} />
					<StockPushCard data={loaded.stockPush} />
					<Locations locations={locations} />
					<Boxes boxes={boxes} />
					<LabelPrintingCard />
				</div>
				<div className="flex flex-col gap-4">
					<Units units={units} />
					<Card title="Stock range">
						<div className="flex flex-col gap-4">
							<MinStockForm
								value={minStock}
								onSave={(min) => saveDefaultMinStock({ data: { min } })}
							/>
							{retail && (
								<ReserveForm
									value={reserve}
									store={retail.name}
									onSave={(units) => saveRetailReserve({ data: { units } })}
								/>
							)}
						</div>
					</Card>
					<EmailTemplatesCard templates={templates} />
					<DevicesCard devices={devices} />
					<ConnectionsCard
						endpoint={loaded.connections.endpoint}
						apps={apps}
						canAdminister={loaded.connections.canAdminister}
					/>
				</div>
			</div>
		</Page>
	);
}

function Channels({ stores }: { stores: Store[] }) {
	return (
		<Card title="Sales channels" flush>
			<ul>
				{channels.flatMap((c) => {
					const connected = stores.filter((s) => s.channel === c.id);
					return (connected.length > 0 ? connected : [null]).map((s) => (
						<Row
							key={s?.id ?? c.id}
							actions={
								s && (
									<>
										{s.primary && <PullNow store={s} />}
										<PrimaryToggle store={s} />
									</>
								)
							}
						>
							<span className="w-24 shrink-0 font-medium">{c.name}</span>
							<span className="truncate">
								{s ? (
									<Badge tone="success">{s.name}</Badge>
								) : (
									<Badge>Not connected</Badge>
								)}
							</span>
						</Row>
					));
				})}
			</ul>
		</Card>
	);
}

type Location = Awaited<ReturnType<typeof listLocations>>[number];

function Locations({ locations }: { locations: Location[] }) {
	return (
		<Card title="Locations" flush>
			<ul>
				{locations.map((l) => (
					<Row
						key={l.id}
						actions={l.kind !== "fba" && <PosToggle location={l} />}
					>
						<span className="flex-1 font-medium">{l.name}</span>
						<span className="text-muted-foreground">
							{l.kind === "fba"
								? "Amazon's warehouse"
								: l.kind === "retail"
									? "Our store; online orders take from it when the warehouse is out"
									: "Ours, ships orders"}
						</span>
					</Row>
				))}
			</ul>
		</Card>
	);
}

// The location Shopify POS sales take stock from. Exactly one is, so the
// current one isn't a button: picking another moves it.
function PosToggle({ location }: { location: Location }) {
	if (location.posPrimary)
		// The Button's box, so the badge sits where the button was.
		return (
			<span className="inline-flex h-8 items-center px-3">
				<Badge tone="info">POS primary</Badge>
			</span>
		);
	return (
		<Button
			size="sm"
			variant="ghost"
			className="text-muted-foreground"
			onClick={() =>
				optimism.change({
					label: `Making ${location.name} POS primary`,
					patch: locationsData.patch("all", (list) =>
						list.map((l) => ({ ...l, posPrimary: l.id === location.id })),
					),
					send: () => savePosLocation({ data: { id: location.id } }),
				})
			}
		>
			POS primary
		</Button>
	);
}

type Box = Awaited<ReturnType<typeof listPackages>>[number];
const inches = (mm: number) => Math.round((mm / 25.4) * 10) / 10;
const ounces = (g: number) => Math.round((g / 28.349523125) * 10) / 10;

// Boxes shown before "Show all", so a long list doesn't push the rest of
// the column off the screen.
const BOX_ROWS = 10;

// The boxes quick ship offers, found there by the size on their label or
// their name. A name is only for telling apart boxes of one size.
function Boxes({ boxes }: { boxes: Box[] }) {
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<number | null>(null);
	const [saving, setSaving] = useState<number | "new" | null>(null);
	const [all, setAll] = useState(false);
	const shown = all ? boxes : boxes.slice(0, BOX_ROWS);

	// A new box's id comes from the server, so the form waits for its answer.
	async function add(values: BoxValues) {
		setSaving("new");
		const r = await optimism.change({
			send: () => savePackage({ data: values }),
		});
		setSaving(null);
		if (!r) return;
		toast.success(`Saved ${boxLabel(r.value)}`);
		setAdding(false);
	}

	// The editor stays open until the server takes the edit, so a refusal leaves
	// the draft there to fix. Then the box shows its new values.
	async function edit(box: Box, values: BoxValues) {
		setSaving(box.id);
		const r = await optimism.change({
			label: `Editing ${boxLabel(box)}`,
			patch: boxesData.patch("all", (list) =>
				list
					.map((b) => (b.id === box.id ? savedBox(b, values) : b))
					.sort((x, y) => volume(x) - volume(y) || x.id - y.id),
			),
			send: () => updatePackage({ data: { ...values, id: box.id } }),
		});
		setSaving(null);
		if (!r) return;
		setEditing((open) => (open === box.id ? null : open));
		toast.success(`Saved ${boxLabel(r.value)}`);
	}

	async function remove(box: Box) {
		const r = await optimism.change({
			label: `Removing ${boxLabel(box)}`,
			patch: boxesData.patch("all", (list) =>
				list.filter((b) => b.id !== box.id),
			),
			send: () => deletePackage({ data: { id: box.id } }),
		});
		if (r) toast.success(`Removed ${boxLabel(box)}`);
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
			{adding && (
				<div className="px-4 pb-3">
					<BoxForm
						saving={saving === "new"}
						onSave={(values) => add(values)}
						onCancel={() => setAdding(false)}
					/>
				</div>
			)}
			{boxes.length === 0 && !adding ? (
				<p className="px-4 pb-3 text-muted-foreground">None.</p>
			) : (
				<ul>
					{shown.map((b) =>
						editing === b.id ? (
							<Row key={b.id}>
								<BoxForm
									box={b}
									saving={saving === b.id}
									onSave={(values) => edit(b, values)}
									onCancel={() => setEditing(null)}
								/>
							</Row>
						) : (
							<Row
								key={b.id}
								actions={
									<>
										<IconAction
											icon={Pencil}
											label="Edit"
											onClick={() => setEditing(b.id)}
										/>
										<IconAction
											icon={Trash2}
											label="Remove"
											onClick={() => remove(b)}
										/>
									</>
								}
							>
								<BoxLabel box={b} />
							</Row>
						),
					)}
					{boxes.length > BOX_ROWS && (
						<li className="border-t">
							<button
								type="button"
								onClick={() => setAll((a) => !a)}
								className="w-full px-4 py-2.5 text-left text-link hover:bg-subtle"
							>
								{all ? "Show fewer" : `Show all ${boxes.length}`}
							</button>
						</li>
					)}
				</ul>
			)}
		</Card>
	);
}

// The size leads, as on the box's label; the name, if any, follows.
function BoxLabel({ box }: { box: Box }) {
	const detail = [
		box.name,
		box.weightGrams > 0 && `${ounces(box.weightGrams)} oz`,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className="min-w-0 flex-1 tabular-nums">
			<p className="truncate font-medium">{boxSize(box)} in</p>
			{detail && <p className="text-xs text-muted-foreground">{detail}</p>}
		</div>
	);
}

const volume = (b: Box) => b.lengthMm * b.widthMm * b.heightMm;

type BoxValues = {
	name: string | null;
	lengthIn: number;
	widthIn: number;
	heightIn: number;
	weightOz: number;
};

const MM_PER_INCH = 25.4;
const GRAMS_PER_OUNCE = 28.349523125;

// A box as the server keeps it (see src/shipping/boxes.ts), so an edit shows
// what will stay.
function savedBox(box: Box, values: BoxValues): Box {
	return {
		...box,
		name: values.name?.trim() || null,
		lengthMm: Math.round(values.lengthIn * MM_PER_INCH),
		widthMm: Math.round(values.widthIn * MM_PER_INCH),
		heightMm: Math.round(values.heightIn * MM_PER_INCH),
		weightGrams: Math.round(values.weightOz * GRAMS_PER_OUNCE),
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
			name: String(f.get("name") ?? "").trim() || null,
			lengthIn: n("length"),
			widthIn: n("width"),
			heightIn: n("height"),
			weightOz: n("weight") || 0,
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
			className="flex w-full flex-wrap items-end gap-2"
		>
			{/* The size first, as on the box's label. */}
			{(["length", "width", "height"] as const).map((d) => (
				<label key={d} className="flex w-16 flex-col gap-1">
					<span className="text-muted-foreground capitalize">{d}</span>
					<input
						name={d}
						required
						// biome-ignore lint/a11y/noAutofocus: opened to type this
						autoFocus={d === "length"}
						inputMode="decimal"
						placeholder="in"
						defaultValue={sides[d]}
						className={field}
					/>
				</label>
			))}
			<label className="flex min-w-32 flex-1 flex-col gap-1">
				<span className="text-muted-foreground">Name</span>
				<input
					name="name"
					placeholder="Only if two share a size"
					defaultValue={box?.name ?? undefined}
					className={field}
				/>
			</label>
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
		<Tip content="Its new SKUs become products">
			<Button size="sm" variant="ghost" onClick={() => set(store.id)}>
				Make primary
			</Button>
		</Tip>
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
