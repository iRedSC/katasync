import { useRef, useState } from "react";
import { toast } from "sonner";
import {
	formatBox,
	GRAMS_PER_OUNCE,
	inches,
	poundsOunces,
} from "#/components/quick-ship/units";
import { cn } from "#/lib/utils";
import { setProductShipping } from "#/server/profit";

type Box = [number, number, number];

const input =
	"h-7 w-14 rounded-md border border-input bg-white px-1.5 text-right tabular-nums outline-none focus:border-ring focus:ring-1 focus:ring-ring";

// A product's packed weight and box, as saved, and set right here: what to
// type into Seller Central next time, and what katasync's own labels use.
// Click to edit; Enter or Save keeps it, Escape leaves it as it was.
export function ShippingDims({
	productId,
	sku,
	weightGrams,
	box,
}: {
	productId: number;
	sku: string | null;
	weightGrams: number | null;
	box: Box | null;
}) {
	const [saved, setSaved] = useState({ weightGrams, box });
	const [editing, setEditing] = useState(false);
	const [flash, setFlash] = useState(false);
	// One save at a time; the form stays as typed until the server says.
	const [saving, setSaving] = useState(false);
	const form = useRef<HTMLFormElement>(null);

	if (!editing) {
		const parts = [
			saved.weightGrams && poundsOunces(saved.weightGrams),
			saved.box && formatBox(saved.box),
		].filter(Boolean);
		return (
			<button
				type="button"
				onClick={() => setEditing(true)}
				className={cn(
					"rounded px-1 transition-colors duration-700 hover:bg-surface hover:underline",
					flash && "bg-success-fill text-success-text",
					parts.length === 0 && "text-warning-text",
				)}
			>
				{parts.length > 0 ? parts.join(" · ") : "Set weight and box"}
			</button>
		);
	}

	const oz = saved.weightGrams ? saved.weightGrams / GRAMS_PER_OUNCE : null;
	const shake = () => {
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		form.current?.animate(
			[0, -6, 6, -4, 4, 0].map((x) => ({ transform: `translateX(${x}px)` })),
			{ duration: 300 },
		);
	};

	async function save(data: FormData) {
		if (saving) return;
		const n = (name: string) => Number(data.get(name) || 0);
		const weightOz = n("lb") * 16 + n("oz");
		const sides = [n("l"), n("w"), n("h")];
		const bad = [
			!(weightOz > 0) && "lb",
			...(["l", "w", "h"] as const).filter((_, i) => !(sides[i] > 0)),
		].filter((f): f is string => Boolean(f));
		for (const el of form.current?.querySelectorAll("input") ?? [])
			el.toggleAttribute(
				"aria-invalid",
				bad.includes(el.name) || (el.name === "oz" && bad.includes("lb")),
			);
		if (bad.length > 0) return shake();
		setSaving(true);
		try {
			const next = await setProductShipping({
				data: { productId, weightOz, box: sides as Box },
			});
			setSaved(next);
			setEditing(false);
			setFlash(true);
			setTimeout(() => setFlash(false), 900);
		} catch (e) {
			shake();
			toast.error(`Couldn't save ${sku ?? "it"}`, {
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setSaving(false);
		}
	}

	const field = (name: string, label: string, value?: number | null) => (
		<input
			name={name}
			aria-label={label}
			placeholder={label}
			inputMode="decimal"
			defaultValue={value ? String(Math.round(value * 10) / 10) : ""}
			disabled={saving}
			className={cn(input, "aria-invalid:border-critical-border")}
		/>
	);
	const [l, w, h] = saved.box?.map(inches) ?? [];
	return (
		<form
			ref={form}
			onSubmit={(e) => {
				// Not a form action: React would clear what was typed when it
				// isn't saved.
				e.preventDefault();
				save(new FormData(e.currentTarget));
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !saving) setEditing(false);
			}}
			className="mt-1 flex flex-wrap items-center gap-1 text-xs text-foreground"
		>
			{field("lb", "lb", oz === null ? null : Math.floor(oz / 16) || null)}
			{field("oz", "oz", oz === null ? null : oz % 16)}
			<span className="mx-1 text-muted-foreground">box</span>
			{field("l", "L in", l)}×{field("w", "W in", w)}×{field("h", "H in", h)}
			<button
				type="submit"
				disabled={saving}
				className="ml-1 h-7 rounded-md bg-primary px-2.5 font-medium text-primary-foreground disabled:opacity-60"
			>
				{saving ? "Saving…" : "Save"}
			</button>
		</form>
	);
}
