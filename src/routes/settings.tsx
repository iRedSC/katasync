import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { DevicesCard } from "#/components/devices-card";
import { LabelPrintingCard } from "#/components/label-printing-card";
import { Badge, Card, Page } from "#/components/page";
import { MinStockForm } from "#/components/stock-range-form";
import { TokensCard } from "#/components/tokens-card";
import { Button } from "#/components/ui/button";
import { channelNames } from "#/lib/format";
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
});

const channels = Object.entries(channelNames).map(([id, name]) => ({
	id,
	name,
}));

function Settings() {
	const { locations, stores, boxes, units, devices, tokens, minStock } =
		Route.useLoaderData();
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
					The primary store's listings become products when no product has their
					SKU yet. Other stores' listings only match.
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
					For products without their own range, set on the product's page. Their
					max comes from their sales: what a reorder tops them up to (lead time,
					the supplier's cover, and safety stock for how much sales swing, more
					for A items), at least 5. The on hand ring on a draft PO fills from
					min to max.
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
	const router = useRouter();
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<number | null>(null);

	async function save(values: BoxValues, box?: Box) {
		try {
			const saved = box
				? await updatePackage({
						data: { ...values, id: box.id, pin: values.pin ?? box.pin },
					})
				: await savePackage({ data: values });
			toast.success(`Saved ${saved.name} as pin ${saved.pin}`);
			setAdding(false);
			setEditing(null);
			router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}

	async function remove(box: Box) {
		try {
			await deletePackage({ data: { id: box.id } });
			router.invalidate();
			toast.success(`Removed ${box.name}`);
		} catch {
			toast.error(`${box.name} is on past labels, so it can't be removed`);
		}
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
					No boxes yet. Each box gets a short pin to type in quick ship
					(Ctrl+Space).
				</p>
			)}
			<ul>
				{boxes.map((b) =>
					editing === b.id ? (
						<li key={b.id} className="border-t first:border-t-0">
							<BoxForm
								box={b}
								onSave={(values) => save(values, b)}
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
						onSave={(values) => save(values)}
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

// Adding a new box, or editing one (filled in with its current values).
// Escape cancels.
function BoxForm({
	box,
	onSave,
	onCancel,
}: {
	box?: Box;
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
			<Button type="submit" size="sm">
				Save
			</Button>
			<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
				Cancel
			</Button>
		</form>
	);
}

type Store = Awaited<ReturnType<typeof listStores>>[number];

function PrimaryToggle({ store }: { store: Store }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	async function set(id: number | null) {
		setBusy(true);
		try {
			const r = await setPrimaryStore({ data: { id } });
			router.invalidate();
			toast.success(
				id === null
					? "No primary store"
					: `${store.name} is primary. ${r.created === 1 ? "1 product" : `${r.created} products`} created from its listings.`,
				r.skipped.length > 0
					? {
							description: `${r.skipped.length} left for you on Listings: ${r.skipped.slice(0, 3).join("; ")}`,
						}
					: undefined,
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return store.primary ? (
		// Same box as the Make primary button, so both line up.
		<Button
			size="sm"
			variant="ghost"
			disabled={busy}
			onClick={() => set(null)}
			title="Click to unset"
		>
			<Badge tone="info">Primary</Badge>
		</Button>
	) : (
		<Button
			size="sm"
			variant="ghost"
			disabled={busy}
			onClick={() => set(store.id)}
		>
			{busy ? "Creating products…" : "Make primary"}
		</Button>
	);
}

type Unit = Awaited<ReturnType<typeof listPurchaseUnits>>[number];

// What suppliers sell in, offered when setting a product's MOQ / UOM. A
// rename carries over to every product in that unit; a unit in use can't be
// removed.
function Units({ units }: { units: Unit[] }) {
	const router = useRouter();
	const [renaming, setRenaming] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);

	async function act(work: () => Promise<unknown>, done: string) {
		try {
			await work();
			await router.invalidate();
			toast.success(done);
			return true;
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
			return false;
		}
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
									onSave={async (to) =>
										(await act(
											() => renamePurchaseUnit({ data: { from: u.name, to } }),
											`Renamed ${u.name}`,
										)) && setRenaming(null)
									}
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
										<Button
											size="sm"
											variant="ghost"
											disabled={u.products > 0}
											title={
												u.products > 0
													? "Change the products bought in it first"
													: undefined
											}
											onClick={() =>
												act(
													() => deletePurchaseUnit({ data: { name: u.name } }),
													`Removed ${u.name}`,
												)
											}
										>
											Remove
										</Button>
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
							onSave={async (name) =>
								(await act(
									() => addPurchaseUnit({ data: { name } }),
									`Added ${name.trim().toUpperCase()}`,
								)) && setAdding(false)
							}
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
