import { useRef, useState } from "react";
import { optimism } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { savePackage } from "#/server/shipping";
import { bigInput } from "./constants";
import { Key } from "./key";
import type { Box, Dims } from "./types";
import { inches, MM_PER_INCH, size } from "./units";

export function PackageStep({
	boxes,
	current,
	dims,
	onChoose,
	onSaved,
}: {
	boxes: Box[];
	current: Box | null;
	dims: Dims | null;
	onChoose: (choice: { box: Box | null; dims: Dims }) => void;
	onSaved: (box: Box) => void;
}) {
	const [value, setValue] = useState(current ? String(current.pin) : "");
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	// The side being typed but not locked in yet, for the hint below.
	const [typing, setTyping] = useState("");
	const [custom, setCustom] = useState(!current && dims !== null);
	const [sides, setSides] = useState(
		dims
			? [dims.lengthMm, dims.widthMm, dims.heightMm].map((mm) =>
					String(inches(mm)),
				)
			: [],
	);
	const match = boxes.find((b) => String(b.pin) === value);
	const parts = [...sides, typing].map(Number).filter((n) => n > 0);

	async function submit(final = parts) {
		if (saving) return;
		if (custom && final.length === 4) {
			// A fourth number is a pin: save this size as a box (no empty
			// weight; add one in Settings if it matters) and ship in it.
			const [l, w, h, pin] = final;
			const taken = boxes.find((b) => b.pin === pin);
			if (taken) return setSaveError(`Pin ${pin} is already ${taken.name}`);
			// The new box needs its id, so it waits for the reload that shows it.
			setSaving(true);
			const r = await optimism.change({
				send: () =>
					savePackage({
						data: {
							name: `${l} × ${w} × ${h}`,
							lengthIn: l,
							widthIn: w,
							heightIn: h,
							weightOz: 0,
							pin,
						},
					}),
			});
			setSaving(false);
			if (!r) return;
			onSaved(r.value);
			onChoose({ box: r.value, dims: r.value });
		} else if (custom && final.length === 3) {
			const [l, w, h] = final.map((n) => Math.round(n * MM_PER_INCH));
			onChoose({ box: null, dims: { lengthMm: l, widthMm: w, heightMm: h } });
		} else if (!custom && match) {
			onChoose({ box: match, dims: match });
		}
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-baseline justify-between">
				<p className="text-xl font-semibold">
					{custom ? "Box size in inches" : "Box pin"}
				</p>
				<button
					type="button"
					className="text-link hover:underline"
					onClick={() => setCustom((c) => !c)}
				>
					{custom ? "Use a saved box" : "Custom size (C or Space)"}
				</button>
			</div>
			{custom ? (
				<SizeInput
					sides={sides}
					onSides={(next) => {
						setSides(next);
						setSaveError(null);
					}}
					onTyping={setTyping}
					onSubmit={(final) => submit(final)}
				/>
			) : (
				<input
					// biome-ignore lint/a11y/noAutofocus: the step exists to type this
					autoFocus
					inputMode="numeric"
					maxLength={3}
					value={value}
					onFocus={(e) => e.target.select()}
					onChange={(e) => {
						if (e.target.value.toLowerCase().endsWith("c")) {
							return setCustom(true);
						}
						setValue(e.target.value.replace(/\D/g, ""));
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") submit();
						// Space means this is a size, not a pin: what's typed so far
						// becomes the length.
						if (e.key === " ") {
							e.preventDefault();
							setSides(Number(value) > 0 ? [value] : []);
							setCustom(true);
						}
					}}
					className={cn(bigInput, "tracking-[0.4em] placeholder:text-line")}
				/>
			)}
			<div className="flex h-8 items-center justify-center text-lg">
				{saving ? (
					<span className="text-muted-foreground">Saving box…</span>
				) : custom && saveError ? (
					<span className="text-critical-text">{saveError}</span>
				) : custom ? (
					parts.length === 4 ? (
						<span>
							Saves as box <span className="font-semibold">{parts[3]}</span>
							<span className="text-muted-foreground">
								{" "}
								· {parts.slice(0, 3).join(" × ")} in
							</span>
						</span>
					) : parts.length === 3 ? (
						<span>
							<span className="font-semibold">{parts.join(" × ")} in</span>
							<span className="text-muted-foreground">
								{" "}
								· <Key>Space</Key> and a pin saves it as a box
							</span>
						</span>
					) : (
						<span className="text-muted-foreground">
							Length <Key>Space</Key> width <Key>Space</Key> height
						</span>
					)
				) : match ? (
					<span>
						<span className="font-semibold">{match.name}</span>
						<span className="text-muted-foreground"> · {size(match)} in</span>
					</span>
				) : boxes.length === 0 ? (
					<span className="text-muted-foreground">
						No saved boxes. Type a custom size.
					</span>
				) : value ? (
					<span className="text-critical-text">No box has that pin</span>
				) : null}
			</div>
		</div>
	);
}

// The fourth number, if typed, saves the size as a box under that pin.
const SIDE_LETTERS = ["L", "W", "H", "PIN"];

// Length, width, height in one box: space locks in a number and labels it
// (40 becomes 40L), backspace on an empty spot reopens the last one, Enter
// takes all three.
function SizeInput({
	sides,
	onSides,
	onTyping,
	onSubmit,
}: {
	sides: string[];
	onSides: (sides: string[]) => void;
	onTyping: (typing: string) => void;
	onSubmit: (final: number[]) => void;
}) {
	const [typing, setTypingHere] = useState("");
	const setTyping = (text: string) => {
		setTypingHere(text);
		onTyping(text);
	};
	const input = useRef<HTMLInputElement>(null);
	const done = sides.length === 4;
	const onPin = sides.length === 3;

	function lockIn() {
		if (Number(typing) > 0 && !done) {
			onSides([...sides, typing]);
			setTyping("");
		}
	}

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: clicking just focuses the real input inside
		// biome-ignore lint/a11y/noStaticElementInteractions: same
		<div
			onClick={() => input.current?.focus()}
			className="flex h-24 w-full cursor-text items-center justify-center gap-5 rounded-xl border-2 border-input bg-white text-6xl font-bold tabular-nums focus-within:border-primary"
		>
			{sides.map((side, i) => (
				<span key={SIDE_LETTERS[i]}>
					{side}
					<span className="ml-0.5 text-2xl font-semibold text-faint">
						{SIDE_LETTERS[i]}
					</span>
				</span>
			))}
			{/* The side being typed shows its letter right after the cursor. */}
			<span className="inline-flex items-baseline">
				<input
					ref={input}
					// biome-ignore lint/a11y/noAutofocus: the step exists to type this
					autoFocus
					inputMode="decimal"
					aria-label="Box size in inches"
					value={typing}
					onChange={(e) =>
						setTyping(
							onPin
								? e.target.value.replace(/\D/g, "").slice(0, 3)
								: e.target.value.replace(/[^\d.]/g, ""),
						)
					}
					onKeyDown={(e) => {
						if ([" ", "x", "X", ","].includes(e.key)) {
							e.preventDefault();
							lockIn();
						}
						if (e.key === "Backspace" && typing === "" && sides.length > 0) {
							e.preventDefault();
							setTyping(sides[sides.length - 1]);
							onSides(sides.slice(0, -1));
						}
						if (e.key === "Enter") {
							const final = [...sides, ...(Number(typing) > 0 ? [typing] : [])]
								.map(Number)
								.filter((n) => n > 0);
							if (final.length >= 3) onSubmit(final);
						}
					}}
					// Exactly as wide as what's typed, so the letter hugs the number.
					className="min-w-[0.15em] bg-transparent outline-none [field-sizing:content]"
				/>
				{!done && (
					<span className="ml-0.5 text-2xl font-semibold text-faint">
						{SIDE_LETTERS[sides.length]}
					</span>
				)}
			</span>
		</div>
	);
}
