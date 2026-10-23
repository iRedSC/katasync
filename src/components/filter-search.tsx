import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { type KeyboardEvent, type RefObject, useState } from "react";
import {
	expandAlias,
	type FieldEntry,
	matchFields,
} from "#/components/filter-fields";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import {
	describeTerm,
	parseSortWord,
	type Sort,
	type SortColumns,
	suggestSorts,
	withTerm,
} from "#/products/sort";

// What one list's search box understands, so products and orders share the
// box but each has its own sigils. F is that list's chip.
export type SearchLanguage<F extends { value: string }> = {
	// The word at the end of the box as a filter being typed, or null when
	// it's plain search text.
	parse: (word: string) => F | null;
	// Values to offer for it, leaving out chips already picked. `detail` says
	// what a value means when its name alone doesn't.
	suggest: (
		typing: F,
		chips: readonly F[],
	) => { value: string; count: number; detail?: string }[];
	// The chip a value locks in as, or null when the value can't be one (an
	// unknown token), so the box never holds a chip that silently matches
	// nothing.
	lock: (typing: F, value: string) => F | null;
	// "not tag", "and vendor": what a chip or suggestion filters on.
	label: (f: F) => string;
	// What the box says when nothing is suggested for what's typed.
	fallback: (typing: F) => string;
	// Filter types to offer while nothing is typed, and the words that turn
	// into their sigils (filter-fields.ts). Without them, neither happens.
	fields?: readonly FieldEntry[];
};

// A search box that turns filters and sorts into chips. Typing "#cl"
// suggests tags containing "cl", "^co" suggests columns to sort on; Tab or
// Enter locks the highlighted one in as a chip. Clicking a sort chip flips
// its direction. Backspace in an empty box removes the last chip.
export function FilterSearch<F extends { value: string }, K extends string>({
	inputRef,
	text,
	onText,
	chips,
	onChips,
	language,
	sort,
	onSort,
	columns,
	placeholder,
}: {
	inputRef: RefObject<HTMLInputElement | null>;
	text: string;
	onText: (text: string) => void;
	chips: F[];
	onChips: (chips: F[]) => void;
	language: SearchLanguage<F>;
	sort: Sort<K>;
	onSort: (sort: Sort<K>) => void;
	columns: SortColumns<K>;
	placeholder: string;
}) {
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [highlight, setHighlight] = useState(0);
	// The filter type picked by arrow keys; none until one is pressed when
	// nothing's typed, so Tab still leaves an empty box.
	const [fieldHighlight, setFieldHighlight] = useState(-1);
	// The last word turned into a sigil, so Backspace can turn it back.
	const [expanded, setExpanded] = useState<{ from: string; to: string } | null>(
		null,
	);

	// Only the word at the end is being typed; earlier ones are already done.
	const word = /\s$/.test(text) ? "" : (text.split(/\s+/).at(-1) ?? "");
	const sorting = parseSortWord(word);
	const typing = sorting ? null : language.parse(word);
	const suggestions = typing ? language.suggest(typing, chips) : [];
	const sortSuggestions = sorting
		? suggestSorts(columns, sorting.value, sort)
		: [];
	const shown = sorting ? sortSuggestions.length : suggestions.length;
	const open = focused && !dismissed && (typing !== null || sorting !== null);
	const fieldEntries =
		language.fields && !typing && !sorting
			? [
					...matchFields(language.fields, word),
					...matchFields(SORT_FIELD, word),
				]
			: [];
	const fieldsOpen = focused && !dismissed && fieldEntries.length > 0;
	const fieldPick = word === "" ? fieldHighlight : Math.max(fieldHighlight, 0);

	function pickField(f: FieldEntry) {
		onText(text.slice(0, text.length - word.length) + f.insert);
		setFieldHighlight(-1);
		setHighlight(0);
	}

	function change(next: string) {
		const typedSpace = next.length === text.length + 1 && next.endsWith(" ");
		const alias =
			typedSpace && language.fields
				? expandAlias([...language.fields, ...SORT_FIELD], next)
				: null;
		setExpanded(alias === null ? null : { from: next, to: alias });
		onText(alias ?? next);
		setDismissed(false);
		setHighlight(0);
		setFieldHighlight(-1);
	}

	function lockSort(key: K) {
		if (!sorting) return;
		onSort(withTerm(sort, { key, desc: sorting.desc }));
		onText(text.slice(0, text.length - word.length));
		setHighlight(0);
	}

	function lock(value: string) {
		const chip = typing && language.lock(typing, value);
		if (!chip) return false;
		onChips([...chips, chip]);
		onText(text.slice(0, text.length - word.length));
		setHighlight(0);
		return true;
	}

	function keyDown(e: KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Backspace" && expanded?.to === text) {
			// Wanted the word itself, not the filter.
			e.preventDefault();
			onText(expanded.from);
			setExpanded(null);
			return;
		}
		if (fieldsOpen) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const n = fieldEntries.length;
				const step = e.key === "ArrowDown" ? 1 : -1;
				setFieldHighlight(
					(i) => (Math.max(i, step > 0 ? -1 : 0) + step + n) % n,
				);
				return;
			}
			const pick = fieldEntries[fieldPick];
			if ((e.key === "Tab" || e.key === "Enter") && pick) {
				e.preventDefault();
				pickField(pick);
				return;
			}
		}
		if ((e.key === "Tab" || e.key === "Enter") && sorting) {
			const pick = sortSuggestions[highlight];
			if (pick) {
				e.preventDefault();
				lockSort(pick);
				return;
			}
		}
		if ((e.key === "Tab" || e.key === "Enter") && typing) {
			const pick = suggestions[highlight]?.value ?? typing.value;
			// A value that can't be a chip stays typed; the list says why.
			if (pick !== "" && lock(pick)) {
				e.preventDefault();
				return;
			}
		}
		if (open && shown > 0) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const step = e.key === "ArrowDown" ? 1 : -1;
				setHighlight((i) => (i + step + shown) % shown);
				return;
			}
		}
		if (e.key === "Escape" && (open || fieldsOpen)) {
			// Close the suggestions; a second Escape leaves the box.
			e.stopPropagation();
			setDismissed(true);
			return;
		}
		const caret = e.currentTarget.selectionStart;
		const nothingSelected = caret === e.currentTarget.selectionEnd;
		if (e.key === "Backspace" && caret === 0 && nothingSelected) {
			// Sort chips sit after the filters, so they go first.
			if (sort.length) {
				e.preventDefault();
				onSort(sort.slice(0, -1));
			} else if (chips.length) {
				e.preventDefault();
				onChips(chips.slice(0, -1));
			}
		}
	}

	return (
		<div className="relative">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: clicking the padding focuses the input */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the input inside takes the keys */}
			<div
				onClick={() => inputRef.current?.focus()}
				className={cn(
					"flex min-h-8 cursor-text flex-wrap items-center gap-1 rounded-lg border border-input bg-white py-0.5 pr-10 pl-8",
					focused && "border-ring ring-1 ring-ring",
				)}
			>
				<Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" />
				{chips.map((chip, i) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: chips can repeat and have no id
						key={i}
						className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-strong pr-0.5 pl-2 text-xs"
					>
						<span className="text-muted-foreground">
							{language.label(chip)}
						</span>
						<span className="font-medium">{chip.value}</span>
						<button
							type="button"
							aria-label={`Remove ${chip.value}`}
							onClick={(e) => {
								e.stopPropagation();
								onChips(chips.filter((_, j) => j !== i));
							}}
							className="rounded p-0.5 text-muted-foreground hover:bg-line hover:text-foreground"
						>
							<X className="size-3" />
						</button>
					</span>
				))}
				{sort.map((term) => {
					const Arrow = term.desc ? ArrowDown : ArrowUp;
					const label = columns[term.key].label;
					return (
						<span
							key={term.key}
							className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-strong pr-0.5 pl-2 text-xs"
						>
							<span className="text-muted-foreground">sort</span>
							<Tip content={describeTerm(term, columns)}>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										onSort(withTerm(sort, { ...term, desc: !term.desc }));
									}}
									className="inline-flex items-center gap-0.5 rounded font-medium hover:text-link"
								>
									{label}
									<Arrow className="size-3" />
								</button>
							</Tip>
							<button
								type="button"
								aria-label={`Stop sorting by ${label}`}
								onClick={(e) => {
									e.stopPropagation();
									onSort(sort.filter((t) => t.key !== term.key));
								}}
								className="rounded p-0.5 text-muted-foreground hover:bg-line hover:text-foreground"
							>
								<X className="size-3" />
							</button>
						</span>
					);
				})}
				<input
					ref={inputRef}
					placeholder={chips.length || sort.length ? "" : placeholder}
					className="h-6 min-w-24 flex-1 bg-transparent outline-none"
					value={text}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					onChange={(e) => change(e.target.value)}
					onKeyDown={keyDown}
				/>
				<kbd className="absolute top-1.5 right-2 rounded border bg-subtle px-1.5 text-xs text-muted-foreground">
					/
				</kbd>
			</div>
			{fieldsOpen && (
				<div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border bg-white py-1 shadow-md">
					{fieldEntries.map((f, i) => (
						<button
							key={f.insert}
							type="button"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => pickField(f)}
							onMouseMove={() => setFieldHighlight(i)}
							className={cn(
								"flex w-full items-center gap-2 px-3 py-1.5 text-left",
								i === fieldPick && "bg-surface",
							)}
						>
							<span className="flex-1 truncate">{f.label}</span>
							<kbd className="min-w-6 rounded border bg-subtle px-1 text-center text-xs text-muted-foreground">
								{f.insert}
							</kbd>
						</button>
					))}
				</div>
			)}
			{open && sorting && (
				<div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border bg-white py-1 shadow-md">
					{sortSuggestions.map((key, i) => (
						<button
							key={key}
							type="button"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => lockSort(key)}
							onMouseMove={() => setHighlight(i)}
							className={cn(
								"flex w-full items-center gap-2 px-3 py-1.5 text-left",
								i === highlight && "bg-surface",
							)}
						>
							<span className="text-muted-foreground">sort</span>
							<span className="flex-1 truncate">{columns[key].label}</span>
							<span className="text-xs text-muted-foreground">
								{sorting.desc ? columns[key].desc : columns[key].asc}
							</span>
							{i === highlight && (
								<kbd className="rounded border bg-subtle px-1 text-xs text-muted-foreground">
									Tab
								</kbd>
							)}
						</button>
					))}
					{sortSuggestions.length === 0 && (
						<p className="px-3 py-1.5 text-muted-foreground">
							{sort.length === Object.keys(columns).length
								? "Already sorting by every column"
								: `No column called “${sorting.value}”`}
						</p>
					)}
					<p className="border-t px-3 pt-1.5 pb-1 text-xs text-muted-foreground">
						^ lowest · ^! highest
					</p>
				</div>
			)}
			{open && typing && (suggestions.length > 0 || typing.value !== "") && (
				<div className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border bg-white py-1 shadow-md">
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
								i === highlight && "bg-surface",
							)}
						>
							<span className="text-muted-foreground">
								{language.label(typing)}
							</span>
							<span className="truncate">{s.value}</span>
							<span className="flex-1 truncate text-xs text-muted-foreground">
								{s.detail}
							</span>
							<span className="text-xs tabular-nums text-muted-foreground">
								{formatCount(s.count)}
							</span>
							{i === highlight && (
								<kbd className="rounded border bg-subtle px-1 text-xs text-muted-foreground">
									Tab
								</kbd>
							)}
						</button>
					))}
					{suggestions.length === 0 && (
						<p className="px-3 py-1.5 text-muted-foreground">
							{language.fallback(typing)}
						</p>
					)}
					{expanded?.to === text && (
						<p className="border-t px-3 pt-1.5 pb-1 text-xs text-muted-foreground">
							<kbd>⌫</kbd> search “{expanded.from.trim()}” instead
						</p>
					)}
				</div>
			)}
		</div>
	);
}

// Sorting, offered beside the filter types.
const SORT_FIELD: readonly FieldEntry[] = [
	{ label: "Sort by", insert: "^", words: ["sort"], negatable: true },
];
