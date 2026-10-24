import { type RefObject, useMemo } from "react";
import {
	FilterPicker,
	type PickField,
	SortMenu,
	ValueList,
} from "#/components/filter-menu";
import {
	FilterSearch,
	type SearchLanguage,
	type Sorting,
} from "#/components/filter-search";
import { RangeCalendar } from "#/components/ui/calendar";
import type { Chip, Index, Search } from "#/lib/facet-search";
import {
	type Day,
	parsePeriod,
	RANGES,
	type RangeKey,
	spellPeriod,
} from "#/lib/period";
import { cn } from "#/lib/utils";
import {
	isColumn,
	type Sort,
	type SortColumns,
	type SortValue,
	sortRows,
	withTerm,
} from "#/products/sort";

// Every list's search: the box, the filter menu, and the sort menu, all
// from one declaration (lib/facet-search.ts). A list that adopts this gets
// whatever the box learns next.

// The search box's language for a declared search over these rows.
export function languageOf<R, K extends string>(
	search: Search<R, K>,
	idx: Index<K>,
): SearchLanguage<Chip<K>> {
	return {
		parse: search.parse,
		suggest: (typing, chips) => search.suggest(idx, typing, chips),
		lock: (typing, value) => search.lock(typing, value, idx),
		label: search.label,
		fallback: search.fallback,
		fields: search.entries,
		show: search.show,
		add: search.add,
		picker: {
			has: (c) => search.fields[c.field].kind === "period",
			render: (c, done) => (
				<PeriodPicker value={c.value} onPick={done} months={2} />
			),
		},
	};
}

// Named ranges beside a calendar for picked days.
export function PeriodPicker({
	value,
	onPick,
	months,
}: {
	value: string;
	onPick: (value: string) => void;
	months: 1 | 2;
}) {
	const current = parsePeriod(value);
	return (
		<div className={cn("flex gap-2", months === 1 && "flex-col")}>
			<ul
				className={cn(
					"flex shrink-0 gap-0.5",
					months === 1 ? "flex-wrap" : "w-32 flex-col border-r pr-2",
				)}
			>
				{(Object.keys(RANGES) as RangeKey[]).map((key) => (
					<li key={key}>
						<button
							type="button"
							onClick={() => onPick(key)}
							className={cn(
								"h-7 w-full rounded-md px-2 text-left text-sm whitespace-nowrap hover:bg-surface",
								current?.kind === "range" &&
									current.key === key &&
									"bg-surface-strong font-medium",
							)}
						>
							{RANGES[key]}
						</button>
					</li>
				))}
			</ul>
			<RangeCalendar
				months={months}
				value={current?.kind === "days" ? current : null}
				onPick={(span) => onPick(spellPeriod({ kind: "days", ...span }))}
			/>
		</div>
	);
}

// The filter menu's fields, from the same declaration.
function pickFields<R, K extends string>(
	search: Search<R, K>,
	idx: Index<K>,
): PickField<Chip<K>>[] {
	return search.keys.map((key) => {
		const f = search.fields[key];
		return {
			key,
			label: f.menu,
			typed: f.sigil,
			body: (add) =>
				f.kind === "period" ? (
					<PeriodPicker
						value=""
						months={1}
						onPick={(value) =>
							add({ field: key, value, exclude: false, exact: true })
						}
					/>
				) : (
					<ValueList
						values={idx.counts.get(key) ?? new Map()}
						details={f.details}
						onAdd={(value, exclude) =>
							add({ field: key, value, exclude, exact: true })
						}
					/>
				),
		};
	});
}

// The rows a list's search keeps, sorted. A sort still being typed applies
// once it names a column exactly.
export function useSearchRows<
	R,
	T extends R,
	K extends string,
	S extends string = never,
>(
	search: Search<R, K>,
	rows: readonly T[],
	chips: readonly Chip<K>[],
	text: string,
	sorting?: {
		sort: Sort<S>;
		columns: SortColumns<S>;
		values: (row: T) => Record<S, SortValue>;
	},
	on?: Day,
) {
	const idx = useMemo(() => search.index(rows, on), [search, rows, on]);
	const q = useMemo(() => search.parseQuery(text), [search, text]);
	const sort = sorting?.sort;
	const columns = sorting?.columns;
	const values = sorting?.values;
	const shown = useMemo(() => {
		const kept = search.filter(
			rows,
			idx,
			[...chips, ...q.filters],
			q.words,
			on,
		);
		if (!sort || !columns || !values) return kept;
		const by = q.sorts.reduce<Sort<S>>(
			(s, t) =>
				isColumn(t.value, columns)
					? withTerm(s, { key: t.value, desc: t.desc })
					: s,
			sort,
		);
		return sortRows(kept, by, values);
	}, [search, rows, idx, chips, q, on, sort, columns, values]);
	const filtering =
		chips.length > 0 || q.filters.some((f) => f.value) || q.words.length > 0;
	return { idx, shown, words: q.words, filtering };
}

export function FilterBar<R, K extends string, S extends string = never>({
	search,
	idx,
	inputRef,
	text,
	onText,
	chips,
	onChips,
	sorting,
	placeholder,
	onSubmit,
	className,
}: {
	search: Search<R, K>;
	idx: Index<K>;
	inputRef: RefObject<HTMLInputElement | null>;
	text: string;
	onText: (text: string) => void;
	chips: Chip<K>[];
	onChips: (chips: Chip<K>[]) => void;
	sorting?: Sorting<S>;
	placeholder: string;
	onSubmit?: () => void;
	className?: string;
}) {
	const language = useMemo(() => languageOf(search, idx), [search, idx]);
	const fields = useMemo(() => pickFields(search, idx), [search, idx]);
	return (
		<div className={cn("flex items-start gap-1", className)}>
			<div className="min-w-0 flex-1">
				<FilterSearch
					inputRef={inputRef}
					text={text}
					onText={onText}
					chips={chips}
					onChips={onChips}
					language={language}
					sorting={sorting}
					placeholder={placeholder}
					onSubmit={onSubmit}
				/>
			</div>
			<FilterPicker<Chip<K>>
				fields={fields}
				onAdd={(c) => onChips(search.add(chips, c))}
			/>
			{sorting && (
				<SortMenu
					sort={sorting.sort}
					onSort={sorting.onSort}
					columns={sorting.columns}
				/>
			)}
		</div>
	);
}
