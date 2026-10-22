import { useRef, useState } from "react";
import { cn } from "#/lib/utils";
import { bigInput } from "./constants";
import { Key } from "./key";
import { GRAMS_PER_OUNCE, ounces } from "./units";

export function WeightStep({
	initialGrams,
	hint,
	moreBoxes,
	onDraft,
	onSubmit,
	onAnother,
}: {
	initialGrams: number | null;
	hint: string | null;
	moreBoxes: boolean;
	onDraft: (grams: number | null) => void;
	onSubmit: (grams: number) => void;
	onAnother: (grams: number) => void;
}) {
	// The mass is kept in grams. The text and unit only show it, so switching
	// units reformats the same mass and never changes what's submitted.
	const [unit, setUnit] = useState<"oz" | "lb">("oz");
	const [mass, setMass] = useState<number | null>(initialGrams);
	const [value, setValue] = useState(
		initialGrams === null ? "" : ounces(initialGrams),
	);
	const input = useRef<HTMLInputElement>(null);
	// Typed text as whole grams, or null when it isn't a weight above zero.
	const grams = (text: string, u: "oz" | "lb") => {
		const n = Number(text);
		return n > 0
			? Math.round((u === "oz" ? n : n * 16) * GRAMS_PER_OUNCE)
			: null;
	};
	// A mass as the input shows it in a unit.
	const show = (g: number, u: "oz" | "lb") =>
		u === "oz" ? ounces(g) : (g / GRAMS_PER_OUNCE / 16).toFixed(2);

	function toggle() {
		const next = unit === "oz" ? "lb" : "oz";
		if (mass !== null) setValue(show(mass, next));
		setUnit(next);
		input.current?.focus();
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-baseline justify-between">
				<p className="text-xl font-semibold">Weight</p>
				{hint && <span className="text-muted-foreground">{hint}</span>}
			</div>
			<div className="relative">
				<input
					ref={input}
					// biome-ignore lint/a11y/noAutofocus: the step exists to type this
					autoFocus
					inputMode="decimal"
					value={value}
					placeholder="0"
					onFocus={(e) => e.target.select()}
					onChange={(e) => {
						const text = e.target.value.replace(/[^\d.]/g, "");
						const next = grams(text, unit);
						setValue(text);
						setMass(next);
						onDraft(next);
					}}
					onKeyDown={(e) => {
						if (e.key === "Tab") {
							e.preventDefault();
							toggle();
						}
						if (e.key === "Enter" && mass) onSubmit(mass);
						// + finishes this box and starts another.
						if (e.key === "+" || e.key === "=") {
							e.preventDefault();
							if (mass) onAnother(mass);
						}
					}}
					className={cn(bigInput, "pr-24 placeholder:text-line")}
				/>
				<button
					type="button"
					onClick={toggle}
					className="absolute top-1/2 right-3 -translate-y-1/2 rounded-lg bg-surface px-3 py-2 text-2xl font-semibold hover:bg-surface-strong"
				>
					{unit}
				</button>
			</div>
			<p className="text-center text-muted-foreground">
				<Key>Tab</Key> switches to {unit === "oz" ? "pounds" : "ounces"} ·{" "}
				<span className={cn(moreBoxes && "font-semibold text-foreground")}>
					<Key>+</Key> another box
				</span>
			</p>
		</div>
	);
}
