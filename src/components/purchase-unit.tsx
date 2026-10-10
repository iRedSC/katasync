import { Link, useRouter } from "@tanstack/react-router";
import { Popover } from "radix-ui";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { formatCount, formatMoney, formatUnit } from "#/lib/format";
import { cn } from "#/lib/utils";
import { setProductPurchaseUnit } from "#/server/purchasing";

const EACH = "EACH";

export type PurchaseUnit = {
	productId: number;
	unit: string;
	packSize: number;
	minimumQuantity: number;
	// The supplier's price per unit, to show what it becomes at a new size.
	cost: number | null;
};

// MOQ and UOM in one cell: "CASE of 12" over "min 2". Click to change both in
// place. Without `units` it's read-only, e.g. on a sent PO.
export function PurchaseUnitCell({
	value,
	units,
	label,
}: {
	value: PurchaseUnit;
	units?: string[];
	// What it's for, for screen readers, e.g. the SKU.
	label: string;
}) {
	const [open, setOpen] = useState(false);
	const shown = (
		<span className="flex flex-col items-start leading-tight">
			<span className={cn(value.unit === EACH && "text-muted-foreground")}>
				{formatUnit(value.unit, value.packSize)}
			</span>
			{value.minimumQuantity > 1 && (
				<span className="text-xs text-muted-foreground">
					min {formatCount(value.minimumQuantity)}
				</span>
			)}
		</span>
	);
	if (!units) return shown;
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				aria-label={`Minimum and unit for ${label}`}
				title="Change the minimum or unit"
				className="cursor-pointer rounded-md border-b border-dotted border-[#b5b5b5] text-left whitespace-nowrap hover:border-foreground"
			>
				{shown}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={6}
					className="z-50 w-64 rounded-xl bg-white p-3 shadow-[0_4px_16px_rgba(0,0,0,0.16),0_0_0_1px_rgba(0,0,0,0.06)]"
				>
					<UnitForm value={value} units={units} onDone={() => setOpen(false)} />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

const input =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring disabled:bg-[#f7f7f7] disabled:text-muted-foreground";

function UnitForm({
	value,
	units,
	onDone,
}: {
	value: PurchaseUnit;
	units: string[];
	onDone: () => void;
}) {
	const router = useRouter();
	const [unit, setUnit] = useState(value.unit);
	const [pack, setPack] = useState(String(value.packSize));
	const [minimum, setMinimum] = useState(String(value.minimumQuantity));
	const [busy, setBusy] = useState(false);

	const packSize = unit === EACH ? 1 : Number(pack);
	const packValid = Number.isInteger(packSize) && packSize > 0;
	const resized = packValid && packSize !== value.packSize;

	async function submit(e: FormEvent) {
		e.preventDefault();
		const minimumQuantity = Number(minimum);
		if (!packValid)
			return toast.error(`"${pack}" isn't a whole number to pack by`);
		if (!Number.isInteger(minimumQuantity) || minimumQuantity < 1)
			return toast.error(`"${minimum}" isn't a whole number`);
		setBusy(true);
		try {
			await setProductPurchaseUnit({
				data: { productId: value.productId, unit, packSize, minimumQuantity },
			});
			await router.invalidate();
			onDone();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-2.5">
			<div className="grid grid-cols-[1fr_5rem] gap-2">
				<label className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">Unit</span>
					<select
						value={unit}
						onChange={(e) => {
							setUnit(e.target.value);
							if (e.target.value === EACH) setPack("1");
						}}
						className={input}
					>
						{units.map((u) => (
							<option key={u} value={u}>
								{u}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">Holds</span>
					<input
						value={unit === EACH ? "1" : pack}
						disabled={unit === EACH}
						inputMode="numeric"
						onChange={(e) => setPack(e.target.value)}
						className={cn(input, "text-right tabular-nums")}
					/>
				</label>
			</div>
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
					Draft quantities convert to the new size
					{value.cost !== null &&
						`, and the price becomes ${formatMoney((value.cost / value.packSize) * packSize)} per ${unit}`}
					.
				</p>
			)}
			<div className="flex items-center gap-2">
				<Button type="submit" size="sm" disabled={busy}>
					Save
				</Button>
				<Button type="button" size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
				<Link
					to="/settings"
					hash="units"
					className="ml-auto text-xs text-link hover:underline"
				>
					Edit units
				</Link>
			</div>
		</form>
	);
}
