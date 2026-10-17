import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
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
import {
	describeTerm,
	parseSortWord,
	type Sort,
	type SortColumns,
	suggestSorts,
	withTerm,
} from "#/products/sort";

const LABEL: Record<Field, string> = {
	tag: "tag",
	type: "type",
	vendor: "vendor",
	status: "status",
	class: "class",
	supplier: "supplier",
	trust: "trust",
	title: "title lacks",
	inventory: "inventory",
	velocity: "sold a month",
};

// "not tag", "and vendor", "title lacks": what a chip or suggestion filters on.
function label(f: Pick<Filter, "field" | "exclude" | "and">) {
	const and = f.and ? "and " : "";
	return f.exclude && f.field !== "title"
		? `${and}not ${LABEL[f.field]}`
		: `${and}${LABEL[f.field]}`;
}

// A search box that turns filters and sorts into chips. Typing "#cl"
// suggests tags containing "cl", "^co" suggests columns to sort on; Tab or
// Enter locks the highlighted one in as a chip. Clicking a sort chip flips
// its direction. Backspace in an empty box removes the last chip.
export function FilterSearch<K extends string>({
	inputRef,
	text,
	onText,
	chips,
	onChips,
	counts,
	sort,
	onSort,
	columns,
	placeholder,
}: {
	inputRef: RefObject<HTMLInputElement | null>;
	text: string;
	onText: (text: string) => void;
	chips: Filter[];
	onChips: (chips: Filter[]) => void;
	counts: ReturnType<typeof facetCounts>;
	sort: Sort<K>;
	onSort: (sort: Sort<K>) => void;
	columns: SortColumns<K>;
	placeholder: string;
}) {
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [highlight, setHighlight] = useState(0);

	// Only the word at the end is being typed; earlier ones are already done.
	const word = /\s$/.test(text) ? "" : (text.split(/\s+/).at(-1) ?? "");
	const sorting = parseSortWord(word);
	const typing = sorting ? null : parseWord(word);
	const suggestions = typing ? suggest(counts, typing, chips) : [];
	const sortSuggestions = sorting
		? suggestSorts(columns, sorting.value, sort)
		: [];
	const shown = sorting ? sortSuggestions.length : suggestions.length;
	const open = focused && !dismissed && (typing !== null || sorting !== null);

	function lockSort(key: K) {
		if (!sorting) return;
		onSort(withTerm(sort, { key, desc: sorting.desc }));
		onText(text.slice(0, text.length - word.length));
		setHighlight(0);
	}

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
			if (pick !== "") {
				e.preventDefault();
				lock(pick);
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
		if (e.key === "Escape" && open) {
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
						<span className="text-muted-foreground">{label(chip)}</span>
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
							<button
								type="button"
								title={describeTerm(term, columns)}
								onClick={(e) => {
									e.stopPropagation();
									onSort(withTerm(sort, { ...term, desc: !term.desc }));
								}}
								className="inline-flex items-center gap-0.5 rounded font-medium hover:text-link"
							>
								{label}
								<Arrow className="size-3" />
							</button>
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
					onChange={(e) => {
						onText(e.target.value);
						setDismissed(false);
						setHighlight(0);
					}}
					onKeyDown={keyDown}
				/>
				<kbd className="absolute top-1.5 right-2 rounded border bg-subtle px-1.5 text-xs text-muted-foreground">
					/
				</kbd>
			</div>
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
								i === highlight && "bg-surface",
							)}
						>
							<span className="text-muted-foreground">{label(typing)}</span>
							<span className="flex-1 truncate">{s.value}</span>
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
							{typing.field === "title"
								? `Tab: hide “${typing.value}”`
								: typing.field === "inventory"
									? `Tab: inventory ${typing.value}`
									: typing.field === "velocity"
										? `Tab: ${typing.value} sold a month`
										: `No ${LABEL[typing.field]} “${typing.value}”. Tab to use anyway.`}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
