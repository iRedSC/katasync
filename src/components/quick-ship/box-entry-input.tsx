import { type KeyboardEvent, useRef } from "react";
import {
	type BoxEntry,
	reopenSide,
	SIDE_LETTERS,
	typeName,
	typeSize,
} from "./box-entry";

// One field for both: locked sides show as 12L 9W with the next letter after
// the cursor, and a name search shows as plain text. It's the same input
// either way, so switching never loses focus.
export function BoxEntryInput({
	entry,
	disabled,
	onEntry,
	onKeyDown,
}: {
	entry: BoxEntry;
	disabled: boolean;
	onEntry: (entry: BoxEntry) => void;
	onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const sides = entry.kind === "size" ? entry.sides : [];
	const nextSide = entry.kind === "size" ? SIDE_LETTERS[sides.length] : null;

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: clicking just focuses the real input inside
		// biome-ignore lint/a11y/noStaticElementInteractions: same
		<div
			onClick={() => input.current?.focus()}
			className="flex h-24 w-full cursor-text items-center justify-center gap-5 overflow-hidden rounded-xl border-2 border-input bg-white px-4 text-6xl font-bold tabular-nums focus-within:border-primary"
		>
			{sides.map((side, i) => (
				<span key={SIDE_LETTERS[i]}>
					{side}
					<span className="ml-0.5 text-2xl font-semibold text-faint">
						{SIDE_LETTERS[i]}
					</span>
				</span>
			))}
			<span className="inline-flex min-w-0 items-baseline">
				<input
					ref={input}
					// biome-ignore lint/a11y/noAutofocus: the step exists to type this
					autoFocus
					disabled={disabled}
					aria-label="Box size or name"
					value={entry.kind === "size" ? entry.typing : entry.text}
					onChange={(e) =>
						onEntry(
							entry.kind === "size"
								? typeSize(entry, e.target.value)
								: typeName(e.target.value),
						)
					}
					onKeyDown={(e) => {
						if (e.key === "Backspace") {
							const reopened = reopenSide(entry);
							if (reopened) {
								e.preventDefault();
								return onEntry(reopened);
							}
						}
						onKeyDown(e);
					}}
					// Exactly as wide as what's typed, so the letter hugs the number.
					className="min-w-[0.15em] max-w-full bg-transparent outline-none [field-sizing:content]"
				/>
				{nextSide && (
					<span className="ml-0.5 text-2xl font-semibold text-faint">
						{nextSide}
					</span>
				)}
			</span>
		</div>
	);
}
