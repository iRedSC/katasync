import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import type { StockRange } from "#/inventory/stock-range";

const box =
	"h-8 w-20 rounded-lg border border-input bg-white px-2 text-right tabular-nums outline-none focus:border-ring";

// "Keep [min] to [max] on hand". With `defaults`, both boxes may be left
// empty to use them, and save null.
export function StockRangeForm({
	value,
	defaults,
	onSave,
}: {
	value: StockRange | null;
	defaults?: StockRange;
	onSave: (range: StockRange | null) => Promise<unknown>;
}) {
	const router = useRouter();
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
		setSaving(true);
		try {
			await onSave(range);
			await router.invalidate();
			toast.success(
				range
					? `Keeping ${range.min} to ${range.max}`
					: "Back on the default range",
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
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
