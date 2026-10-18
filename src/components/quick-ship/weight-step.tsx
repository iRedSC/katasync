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
	const [unit, setUnit] = useState<"oz" | "lb">("oz");
	const [value, setValue] = useState(
		initialGrams === null ? "" : ounces(initialGrams),
	);
	const input = useRef<HTMLInputElement>(null);
	const grams = (text: string, u: "oz" | "lb") => {
		const n = Number(text);
		return n > 0
			? Math.round((u === "oz" ? n : n * 16) * GRAMS_PER_OUNCE)
			: null;
	};

	function toggle() {
		const n = Number(value);
		const next = unit === "oz" ? "lb" : "oz";
		if (n > 0) {
			setValue(next === "lb" ? (n / 16).toFixed(2) : (n * 16).toFixed(1));
		}
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
						setValue(text);
						onDraft(grams(text, unit));
					}}
					onKeyDown={(e) => {
						if (e.key === "Tab") {
							e.preventDefault();
							toggle();
						}
						const g = grams(value, unit);
						if (e.key === "Enter" && g) onSubmit(g);
						// + finishes this box and starts another.
						if (e.key === "+" || e.key === "=") {
							e.preventDefault();
							if (g) onAnother(g);
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
