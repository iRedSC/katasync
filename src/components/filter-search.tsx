import { Search, X } from "lucide-react";
import { type KeyboardEvent, type RefObject, useState } from "react";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import {
	type Field,
	type Filter,
	type facetCounts,
	parseWord,
	suggest,
} from "#/products/search";

const LABEL: Record<Field, string> = {
	tag: "tag",
	type: "type",
	vendor: "vendor",
	status: "status",
	class: "class",
	title: "title lacks",
	inventory: "inventory",
};

// "not tag", "and vendor", "title lacks": what a chip or suggestion filters on.
function label(f: Pick<Filter, "field" | "exclude" | "and">) {
	const and = f.and ? "and " : "";
	return f.exclude && f.field !== "title"
		? `${and}not ${LABEL[f.field]}`
		: `${and}${LABEL[f.field]}`;
}

// A search box that turns filters into chips. Typing "#cl" suggests tags
// containing "cl"; Tab or Enter locks the highlighted one in as a chip.
// Backspace in an empty box removes the last chip. Keys it doesn't use (Enter
// with no filter being typed, arrows when nothing is suggested) go to
// onKeyDown, so the list below can use them.
export function FilterSearch({
	inputRef,
	text,
	onText,
	chips,
	onChips,
	counts,
	placeholder,
	onKeyDown,
}: {
	inputRef: RefObject<HTMLInputElement | null>;
	text: string;
	onText: (text: string) => void;
	chips: Filter[];
	onChips: (chips: Filter[]) => void;
	counts: ReturnType<typeof facetCounts>;
	placeholder: string;
	onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [highlight, setHighlight] = useState(0);

	// Only the word at the end is being typed; earlier ones are already done.
	const word = /\s$/.test(text) ? "" : (text.split(/\s+/).at(-1) ?? "");
	const typing = parseWord(word);
	const suggestions = typing ? suggest(counts, typing, chips) : [];
	const open = focused && !dismissed && typing !== null;

	function lock(value: string) {
		if (!typing) return;
		onChips([
			...chips,
			// Title exclusions stay "contains": nobody types a whole title.
			{ ...typing, value, exact: typing.field !== "title" },
		]);
		onText(text.slice(0, text.length - word.length));
		setHighlight(0);
	}

	function keyDown(e: KeyboardEvent<HTMLInputElement>) {
		if ((e.key === "Tab" || e.key === "Enter") && typing) {
			const pick = suggestions[highlight]?.value ?? typing.value;
			if (pick !== "") {
				e.preventDefault();
				lock(pick);
				return;
			}
		}
		if (open && suggestions.length > 0) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const step = e.key === "ArrowDown" ? 1 : -1;
				setHighlight(
					(i) => (i + step + suggestions.length) % suggestions.length,
				);
				return;
			}
		}
		if (e.key === "Escape" && open) {
			// Close the suggestions; a second Escape leaves the box.
			e.stopPropagation();
			setDismissed(true);
			return;
		}
		const caret = e.currentTarget.selectionStart;
		const nothingSelected = caret === e.currentTarget.selectionEnd;
		if (
			e.key === "Backspace" &&
			caret === 0 &&
			nothingSelected &&
			chips.length
		) {
			e.preventDefault();
			onChips(chips.slice(0, -1));
			return;
		}
		onKeyDown(e);
	}

	return (
		<div className="relative">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: clicking the padding focuses the input */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the input inside takes the keys */}
			<div
				onClick={() => inputRef.current?.focus()}
				className={cn(
					"flex min-h-8 cursor-text flex-wrap items-center gap-1 rounded-lg border border-[#8a8a8a] bg-white py-0.5 pr-10 pl-8",
					focused && "border-ring ring-1 ring-ring",
				)}
			>
				<Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" />
				{chips.map((chip, i) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: chips can repeat and have no id
						key={i}
						className="inline-flex h-6 items-center gap-1 rounded-md bg-[#e3e3e3] pr-0.5 pl-2 text-xs"
					>
						<span className="text-muted-foreground">{label(chip)}</span>
						<span className="font-medium">{chip.value}</span>
						<button
							type="button"
							aria-label={`Remove ${chip.value}`}
							onClick={(e) => {
								e.stopPropagation();
								onChips(chips.filter((_, j) => j !== i));
							}}
							className="rounded p-0.5 text-muted-foreground hover:bg-[#d4d4d4] hover:text-foreground"
						>
							<X className="size-3" />
						</button>
					</span>
				))}
				<input
					ref={inputRef}
					placeholder={chips.length ? "" : placeholder}
					className="h-6 min-w-24 flex-1 bg-transparent outline-none"
					value={text}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					onChange={(e) => {
						onText(e.target.value);
						setDismissed(false);
						setHighlight(0);
					}}
					onKeyDown={keyDown}
				/>
				<kbd className="absolute top-1.5 right-2 rounded border bg-[#f7f7f7] px-1.5 text-xs text-muted-foreground">
					/
				</kbd>
			</div>
			{open && (suggestions.length > 0 || typing.value !== "") && (
				<div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border bg-white py-1 shadow-md">
					{suggestions.map((s, i) => (
						<button
							key={s.value}
							type="button"
							// Keep focus in the input so Tab and typing carry on.
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => lock(s.value)}
							onMouseMove={() => setHighlight(i)}
							className={cn(
								"flex w-full items-center gap-2 px-3 py-1.5 text-left",
								i === highlight && "bg-[#f1f1f1]",
							)}
						>
							<span className="text-muted-foreground">{label(typing)}</span>
							<span className="flex-1 truncate">{s.value}</span>
							<span className="text-xs tabular-nums text-muted-foreground">
								{formatCount(s.count)}
							</span>
							{i === highlight && (
								<kbd className="rounded border bg-[#f7f7f7] px-1 text-xs text-muted-foreground">
									Tab
								</kbd>
							)}
						</button>
					))}
					{suggestions.length === 0 && (
						<p className="px-3 py-1.5 text-muted-foreground">
							{typing.field === "title"
								? `Tab to hide titles containing “${typing.value}”`
								: typing.field === "inventory"
									? `Tab to keep inventory ${typing.value}`
									: `No ${LABEL[typing.field]} is “${typing.value}”. Tab to lock it in anyway.`}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
