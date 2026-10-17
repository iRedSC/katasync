import { Popover } from "radix-ui";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatMoney, supplierUnit } from "#/lib/format";
import { optimism, type Patch } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { addPurchaseUnit } from "#/server/purchasing";

const EACH = "EACH";

// packSize is how many of the product one unit adds to stock; supplierCount
// is the count the supplier puts on it, printed on the PO.
export type PurchaseTerms = {
	unit: string;
	packSize: number;
	supplierCount: number;
	minimumQuantity: number;
};

// How saving works where the cell is used. On a PO, `save` changes just that
// PO, and `saveDefault` (when allowed) also makes the terms the product's
// default. On a product page there's no PO, so `save` sets the default. Each
// is a plain server call. `patch` and `patchDefault` show what they change on
// the page at once; without them the page shows it once reloaded.
export type SaveTerms = {
	save: (terms: PurchaseTerms) => Promise<unknown>;
	saveDefault?: (terms: PurchaseTerms) => Promise<unknown>;
	patch?: (terms: PurchaseTerms) => Patch;
	patchDefault?: (terms: PurchaseTerms) => Patch;
	// Why Set default is unavailable, when it is.
	noDefaultReason?: string;
	// The product's default now, so the form can say when it's on it.
	current?: PurchaseTerms;
};

// MOQ and UOM in one cell: "CASE of 12" over "min 2", with "counts as 1" when
// the supplier's count isn't ours. Click to change them in place. Without
// `units` it's read-only, e.g. on a sent PO.
export function PurchaseUnitCell({
	value,
	cost,
	units,
	saving,
	label,
}: {
	value: PurchaseTerms;
	// The price per unit, to show what it becomes at a new size.
	cost: number | null;
	units?: string[];
	saving?: SaveTerms;
	// What it's for, for screen readers, e.g. the SKU.
	label: string;
}) {
	const [open, setOpen] = useState(false);
	const shown = (
		<span className="flex flex-col items-start leading-tight">
			<span className={cn(value.unit === EACH && "text-muted-foreground")}>
				{supplierUnit(value)}
			</span>
			{value.supplierCount !== value.packSize && (
				<span className="text-xs text-muted-foreground">
					counts as {formatCount(value.packSize)}
				</span>
			)}
			{value.minimumQuantity > 1 && (
				<span className="text-xs text-muted-foreground">
					min {formatCount(value.minimumQuantity)}
				</span>
			)}
		</span>
	);
	if (!units || !saving) return shown;
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				aria-label={`Minimum and unit for ${label}`}
				className="cursor-pointer rounded-md border-b border-dotted border-faint text-left whitespace-nowrap hover:border-foreground"
			>
				{shown}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={6}
					className="z-50 w-64 rounded-xl bg-white p-3 shadow-[0_4px_16px_rgba(0,0,0,0.16),0_0_0_1px_rgba(0,0,0,0.06)]"
				>
					<TermsForm
						value={value}
						cost={cost}
						units={units}
						label={label}
						saving={saving}
						onDone={() => setOpen(false)}
					/>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

const input =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring disabled:bg-subtle disabled:text-muted-foreground";

function TermsForm({
	value,
	cost,
	units: initialUnits,
	label,
	saving,
	onDone,
}: {
	value: PurchaseTerms;
	cost: number | null;
	units: string[];
	label: string;
	saving: SaveTerms;
	onDone: () => void;
}) {
	const [units, setUnits] = useState(initialUnits);
	const [unit, setUnit] = useState(value.unit);
	const [adding, setAdding] = useState(false);
	const [newUnit, setNewUnit] = useState("");
	const [count, setCount] = useState(String(value.supplierCount));
	const [pack, setPack] = useState(String(value.packSize));
	// "Counts as" follows the supplier's count until it's set apart, so the
	// usual pack, where theirs is ours, is one number to type.
	const [apart, setApart] = useState(value.packSize !== value.supplierCount);
	const [minimum, setMinimum] = useState(String(value.minimumQuantity));
	const [busy, setBusy] = useState(false);

	const supplierCount = unit === EACH ? 1 : Number(count);
	const countValid = Number.isInteger(supplierCount) && supplierCount > 0;
	const packSize = unit === EACH ? 1 : apart ? Number(pack) : supplierCount;
	const packValid = Number.isInteger(packSize) && packSize > 0;
	const resized = packValid && packSize !== value.packSize;

	// The name comes back from the server, which may tidy it, so it waits for
	// the reload before it's offered as a unit.
	async function addUnit() {
		if (newUnit.trim() === "") return setAdding(false);
		const added = await optimism.change({
			send: () => addPurchaseUnit({ data: { name: newUnit } }),
		});
		if (!added) return;
		setUnits((all) => [...all, added.value]);
		setUnit(added.value);
		setAdding(false);
		setNewUnit("");
	}

	// Saves the terms with `send`. With a `patch` the cell shows them at once
	// and closes; without one it stays busy until the page has reloaded.
	async function submit(send: SaveTerms["save"], patch?: SaveTerms["patch"]) {
		const minimumQuantity = Number(minimum);
		if (!countValid)
			return toast.error(`"${count}" isn't a whole number to pack by`);
		if (!packValid)
			return toast.error(`"${pack}" isn't a whole number to count it as`);
		if (!Number.isInteger(minimumQuantity) || minimumQuantity < 1)
			return toast.error(`"${minimum}" isn't a whole number`);
		const terms = { unit, packSize, supplierCount, minimumQuantity };
		const sending = () => send(terms);
		if (patch) {
			onDone();
			await optimism.change({
				label: `${label}'s unit and minimum`,
				patch: patch(terms),
				send: sending,
			});
			return;
		}
		setBusy(true);
		const saved = await optimism.change({ send: sending });
		setBusy(false);
		if (saved) onDone();
	}

	return (
		<form
			onSubmit={(e: FormEvent) => {
				e.preventDefault();
				submit(saving.save, saving.patch);
			}}
			className="flex flex-col gap-2.5"
		>
			<div className="grid grid-cols-[1fr_5rem] gap-2">
				<div className="flex flex-col gap-1">
					<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
						Unit
						{!adding && (
							<button
								type="button"
								onClick={() => setAdding(true)}
								className="text-link hover:underline"
							>
								add
							</button>
						)}
					</span>
					{adding ? (
						<input
							value={newUnit}
							// biome-ignore lint/a11y/noAutofocus: opened to type a name
							autoFocus
							placeholder="e.g. ROLL"
							aria-label="New unit"
							onChange={(e) => setNewUnit(e.target.value)}
							onBlur={addUnit}
							onKeyDown={(e) => {
								// Enter adds the unit rather than saving the form.
								if (e.key === "Enter") {
									e.preventDefault();
									e.currentTarget.blur();
								}
								if (e.key === "Escape") {
									e.stopPropagation();
									setNewUnit("");
									setAdding(false);
								}
							}}
							className={cn(input, "uppercase")}
						/>
					) : (
						<select
							value={unit}
							aria-label="Unit"
							onChange={(e) => {
								setUnit(e.target.value);
								if (e.target.value === EACH) {
									setCount("1");
									setPack("1");
									setApart(false);
								}
							}}
							className={input}
						>
							{units.map((u) => (
								<option key={u} value={u}>
									{u}
								</option>
							))}
						</select>
					)}
				</div>
				<label className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">Of</span>
					<Tip content="The supplier's count, printed on the PO">
						<input
							value={unit === EACH ? "1" : count}
							disabled={unit === EACH}
							inputMode="numeric"
							onChange={(e) => setCount(e.target.value)}
							className={cn(input, "text-right tabular-nums")}
						/>
					</Tip>
				</label>
			</div>
			{unit !== EACH && (
				<div className="flex flex-col gap-1">
					<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
						Counts as, in stock
						<button
							type="button"
							onClick={() => {
								// Set apart, it starts from the supplier's count.
								if (!apart) setPack(count);
								setApart(!apart);
							}}
							className="text-link hover:underline"
						>
							{apart ? "same as theirs" : "change"}
						</button>
					</span>
					{apart ? (
						<input
							value={pack}
							inputMode="numeric"
							aria-label="Counts as, in stock"
							onChange={(e) => setPack(e.target.value)}
							className={cn(input, "text-right tabular-nums")}
						/>
					) : (
						<span className="text-sm tabular-nums">
							{countValid ? formatCount(supplierCount) : "?"}, the same as
							theirs
						</span>
					)}
					{apart && countValid && packValid && (
						<p className="text-xs text-muted-foreground">
							The PO says {supplierUnit({ unit, supplierCount })}; receiving one
							adds {formatCount(packSize)} to stock.
						</p>
					)}
				</div>
			)}
			<label className="flex flex-col gap-1">
				<span className="text-xs text-muted-foreground">
					Minimum order, in {unit}
				</span>
				<input
					value={minimum}
					// biome-ignore lint/a11y/noAutofocus: the field most often changed
					autoFocus
					inputMode="numeric"
					onFocus={(e) => e.currentTarget.select()}
					onChange={(e) => setMinimum(e.target.value)}
					className={cn(input, "text-right tabular-nums")}
				/>
			</label>
			{resized && (
				<p className="text-xs text-muted-foreground">
					The quantity converts to the new size
					{cost !== null &&
						`, and the price becomes ${formatMoney((cost / value.packSize) * packSize)} per ${unit}`}
					.
				</p>
			)}
			<div className="flex items-center gap-2">
				<Button type="submit" size="sm" disabled={busy || adding}>
					Save
				</Button>
				<Button type="button" size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
				{saving.saveDefault &&
				saving.current?.unit === unit &&
				saving.current.packSize === packSize &&
				saving.current.supplierCount === supplierCount &&
				String(saving.current.minimumQuantity) === minimum.trim() ? (
					<span className="ml-auto text-xs text-muted-foreground">Default</span>
				) : (
					(saving.saveDefault || saving.noDefaultReason) && (
						// ml-auto on the wrapper: a disabled button's tip wraps it in a span.
						<span className="ml-auto">
							<Tip content={saving.noDefaultReason ?? "Use on future POs"}>
								<button
									type="button"
									disabled={busy || adding || !saving.saveDefault}
									onClick={() =>
										saving.saveDefault &&
										submit(saving.saveDefault, saving.patchDefault)
									}
									className="text-xs text-link hover:underline disabled:text-muted-foreground disabled:no-underline"
								>
									Set default
								</button>
							</Tip>
						</span>
					)
				)}
			</div>
		</form>
	);
}
