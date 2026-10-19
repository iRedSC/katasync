import { Lock } from "lucide-react";
import type { RefObject } from "react";
import { formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import { parseInsurance } from "./insurance";
import { Key } from "./key";

// The amount to insure, typed like a box side: the $ hugs the number.
export function InsuranceField({
	text,
	total,
	boxes,
	recommended,
	disabled,
	input,
	onText,
}: {
	text: string;
	total: number;
	boxes: number;
	recommended: boolean;
	disabled: boolean;
	input: RefObject<HTMLInputElement | null>;
	onText: (text: string) => void;
}) {
	const full = parseInsurance(text) === parseInsurance(String(total));
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: clicking just focuses the real input inside
		// biome-ignore lint/a11y/noStaticElementInteractions: same
		<div
			onClick={() => input.current?.focus()}
			className={cn(
				"flex h-16 min-w-0 flex-1 cursor-text items-center gap-3 rounded-xl border-2 border-input bg-white px-4 focus-within:border-primary",
				disabled && "cursor-not-allowed opacity-50",
			)}
		>
			<span className="flex flex-col text-xs font-medium tracking-wide text-muted-foreground uppercase">
				Insure
				{recommended && (
					<span className="font-semibold text-warning-text normal-case tracking-normal">
						Recommended
					</span>
				)}
			</span>
			<span className="inline-flex min-w-0 items-baseline text-4xl font-bold tabular-nums">
				<span className="mr-0.5 text-2xl font-semibold text-faint">$</span>
				<input
					ref={input}
					// biome-ignore lint/a11y/noAutofocus: shown to type the amount
					autoFocus
					disabled={disabled}
					inputMode="decimal"
					aria-label="Insure for"
					placeholder="0"
					value={text}
					onChange={(e) => onText(e.target.value)}
					// Exactly as wide as what's typed, so the $ hugs the number.
					className="min-w-[0.6em] max-w-full bg-transparent outline-none [field-sizing:content] placeholder:text-faint"
				/>
			</span>
			<span
				className={cn(
					"ml-auto shrink-0 text-right text-sm text-muted-foreground",
					disabled && "invisible",
				)}
			>
				{boxes > 1 && <span className="block">Split over {boxes} boxes</span>}
				<Key>Tab</Key> {full ? "none" : `full ${formatMoney(total)}`}
			</span>
		</div>
	);
}

// Signature on delivery, on or off with S. Locked on when the order needs one.
export function SignatureToggle({
	on,
	locked,
	disabled,
	onToggle,
}: {
	on: boolean;
	locked: boolean;
	disabled: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			disabled={disabled}
			// Out of the Tab order: Tab belongs to the insurance field.
			tabIndex={-1}
			onClick={onToggle}
			className={cn(
				"flex h-16 shrink-0 items-center gap-3 rounded-xl border-2 px-4",
				on ? "border-primary" : "border-border hover:bg-subtle",
				(locked || disabled) && "cursor-not-allowed",
				disabled && "opacity-50",
			)}
		>
			<span
				className={cn(
					"flex h-6 w-10 items-center rounded-full p-0.5 transition-colors",
					on ? "justify-end bg-primary" : "justify-start bg-border",
				)}
			>
				<span className="size-5 rounded-full bg-white shadow" />
			</span>
			<span className="text-lg font-semibold">Signature</span>
			{disabled ? null : locked ? (
				<Lock className="size-4 text-muted-foreground" aria-label="Required" />
			) : (
				<Key>S</Key>
			)}
		</button>
	);
}
