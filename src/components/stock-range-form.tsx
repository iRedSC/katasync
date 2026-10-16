import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import type { StockRange } from "#/inventory/stock-range";
import { optimism, type Patch } from "#/lib/optimism";

const box =
	"h-8 w-20 rounded-lg border border-input bg-white px-2 text-right tabular-nums outline-none focus:border-ring";

// "Keep [min] to [max] on hand". With `defaults` (shown as placeholders), both
// boxes may be left empty to use them, and save null. `patch` says how a saved
// range shows on the page it's on, so it shows at once; without it, the form
// waits for the server.
export function StockRangeForm({
	value,
	defaults,
	onSave,
	patch,
}: {
	value: StockRange | null;
	defaults?: StockRange;
	onSave: (range: StockRange | null) => Promise<unknown>;
	patch?: (range: StockRange | null) => { label: string; patch: Patch };
}) {
	const [min, setMin] = useState(value ? String(value.min) : "");
	const [max, setMax] = useState(value ? String(value.max) : "");
	const [saving, setSaving] = useState(false);
	const dirty =
		min !== (value ? String(value.min) : "") ||
		max !== (value ? String(value.max) : "");

	async function save() {
		const empty = min.trim() === "" && max.trim() === "";
		if (empty && !defaults) return toast.error("Fill in both");
		const range = empty ? null : { min: Number(min), max: Number(max) };
		if (range && (min.trim() === "" || max.trim() === ""))
			return toast.error("Fill in both, or leave both empty for the default");
		if (
			range &&
			!(
				Number.isInteger(range.min) &&
				Number.isInteger(range.max) &&
				range.min >= 0 &&
				range.max > range.min
			)
		)
			return toast.error("Min and max are whole numbers, with max above min");
		const laid = patch?.(range);
		// Only a change that waits for the server holds the form.
		if (!laid) setSaving(true);
		const r = await optimism.change(
			laid
				? { ...laid, send: () => onSave(range) }
				: { send: () => onSave(range) },
		);
		setSaving(false);
		if (r)
			toast.success(
				range
					? `Keeping ${range.min} to ${range.max}`
					: "Back on the default range",
			);
	}

	return (
		<form
			className="flex flex-wrap items-center gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			Keep
			<input
				value={min}
				inputMode="numeric"
				aria-label="Min stock"
				placeholder={defaults ? String(defaults.min) : "Min"}
				onChange={(e) => setMin(e.target.value)}
				className={box}
			/>
			to
			<input
				value={max}
				inputMode="numeric"
				aria-label="Max stock"
				placeholder={defaults ? String(defaults.max) : "Max"}
				onChange={(e) => setMax(e.target.value)}
				className={box}
			/>
			on hand
			{dirty && (
				<Button type="submit" size="sm" variant="outline" disabled={saving}>
					Save
				</Button>
			)}
		</form>
	);
}

// "Keep at least [min] on hand", for the default every product starts from.
// Its change has no patch: the settings page reloads once it's saved.
export function MinStockForm({
	value,
	onSave,
}: {
	value: number;
	onSave: (min: number) => Promise<unknown>;
}) {
	const [min, setMin] = useState(String(value));
	const [saving, setSaving] = useState(false);

	async function save() {
		const n = Number(min);
		if (min.trim() === "" || !Number.isInteger(n) || n < 0)
			return toast.error("Min is a whole number from 0");
		setSaving(true);
		const r = await optimism.change({ send: () => onSave(n) });
		setSaving(false);
		if (r) toast.success(`Keeping at least ${n} by default`);
	}

	return (
		<form
			className="flex flex-wrap items-center gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			Keep at least
			<input
				value={min}
				inputMode="numeric"
				aria-label="Min stock"
				onChange={(e) => setMin(e.target.value)}
				className={box}
			/>
			on hand
			{min !== String(value) && (
				<Button type="submit" size="sm" variant="outline" disabled={saving}>
					Save
				</Button>
			)}
		</form>
	);
}
