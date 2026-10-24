import {
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	ChevronLeft,
	ListFilter,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Field, Filter, facetCounts } from "#/products/search";
import {
	describeTerm,
	type Sort,
	type SortColumns,
	type SortTerm,
} from "#/products/sort";

// The fields the filter button offers, in the order shown. Each says how to
// type it, so the menu also teaches the search language.
const FIELDS: { field: Field; label: string; typed: string }[] = [
	{ field: "status", label: "Status", typed: "%" },
	{ field: "class", label: "Class", typed: "*" },
	{ field: "trust", label: "Trust", typed: "~" },
	{ field: "supplier", label: "Supplier", typed: "&" },
	{ field: "inventory", label: "Inventory", typed: ">=3" },
	{ field: "velocity", label: "Sold a month", typed: "v>=3" },
	{ field: "type", label: "Type", typed: "@" },
	{ field: "vendor", label: "Vendor", typed: "$" },
	{ field: "tag", label: "Tag", typed: "#" },
	{ field: "title", label: "Title doesn't contain", typed: "!!" },
];

const iconButton =
	"inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-input bg-white text-muted-foreground hover:bg-subtle data-[state=open]:bg-surface";

// One field the filter button offers: how to type it, so the menu also
// teaches the search language, and what to pick its value with.
export type PickField<F> = {
	key: string;
	label: string;
	typed: string;
	body: (add: (filter: F) => void) => ReactNode;
};

// Adds a chip by picking instead of typing: a field, then a value.
export function FilterPicker<F>({
	fields,
	onAdd,
}: {
	fields: readonly PickField<F>[];
	onAdd: (filter: F) => void;
}) {
	const [open, setOpen] = useState(false);
	const [key, setKey] = useState<string | null>(null);
	const field = fields.find((f) => f.key === key);

	function add(filter: F) {
		onAdd(filter);
		setOpen(false);
	}

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setKey(null);
			}}
		>
			<PopoverTrigger className={iconButton} aria-label="Add a filter">
				<ListFilter className="size-4" />
			</PopoverTrigger>
			<PopoverContent className="w-auto max-w-[22rem] min-w-72">
				{!field ? (
					<ul>
						{fields.map((f) => (
							<li key={f.key}>
								<button
									type="button"
									onClick={() => setKey(f.key)}
									className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left hover:bg-surface"
								>
									{f.label}
									<kbd className="text-xs text-muted-foreground">{f.typed}</kbd>
								</button>
							</li>
						))}
					</ul>
				) : (
					<div className="flex flex-col gap-1">
						<button
							type="button"
							onClick={() => setKey(null)}
							className="flex h-8 items-center gap-1 rounded-lg px-1 font-semibold hover:bg-surface"
						>
							<ChevronLeft className="size-4" />
							{field.label}
						</button>
						<div key={field.key} className="contents">
							{field.body(add)}
						</div>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

// The product filter button.
export function AddFilter({
	counts,
	onAdd,
}: {
	counts: ReturnType<typeof facetCounts>;
	onAdd: (filter: Filter) => void;
}) {
	const fields = FIELDS.map(
		({ field, label, typed }): PickField<Filter> => ({
			key: field,
			label,
			typed,
			body: (done) => {
				const add = (f: Omit<Filter, "and" | "exact">) =>
					done({ ...f, and: false, exact: f.field !== "title" });
				return field === "inventory" || field === "velocity" ? (
					<ComparisonForm field={field} onAdd={add} />
				) : field === "title" ? (
					<TextForm
						placeholder="Word"
						onAdd={(value) => add({ field: "title", value, exclude: true })}
					/>
				) : (
					<ValueList
						values={counts.get(field) ?? new Map()}
						onAdd={(value, exclude) => add({ field, value, exclude })}
					/>
				);
			},
		}),
	);
	return <FilterPicker fields={fields} onAdd={onAdd} />;
}

// Every value of one field, most common first, narrowed by what's typed. All
// of them: a few hundred rows is cheap, and a cut-off list looks complete.
// `details` says what a value means when its name alone doesn't.
export function ValueList({
	values,
	details,
	onAdd,
}: {
	values: ReadonlyMap<string, number>;
	details?: ReadonlyMap<string, string>;
	onAdd: (value: string, exclude: boolean) => void;
}) {
	const [q, setQ] = useState("");
	const [exclude, setExclude] = useState(false);
	const shown = [...values]
		.filter(([v]) => v.toLowerCase().includes(q.toLowerCase()))
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return (
		<>
			{values.size > 8 && (
				<input
					// biome-ignore lint/a11y/noAutofocus: the menu was opened to pick from this list
					autoFocus
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Find a value"
					className="mx-1 h-8 rounded-lg border border-input px-2 outline-none focus:border-ring focus:ring-1 focus:ring-ring"
				/>
			)}
			<div className="mx-1 flex rounded-lg bg-surface p-0.5 text-xs font-medium">
				{[false, true].map((x) => (
					<button
						key={String(x)}
						type="button"
						onClick={() => setExclude(x)}
						className={cn(
							"h-6 flex-1 rounded-md",
							exclude === x ? "bg-white shadow-card" : "text-muted-foreground",
						)}
					>
						{x ? "Leave out" : "Only show"}
					</button>
				))}
			</div>
			<ul className="max-h-72 overflow-y-auto">
				{shown.map(([value, count]) => (
					<li key={value}>
						<button
							type="button"
							onClick={() => onAdd(value, exclude)}
							className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-surface"
						>
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate">{value}</span>
								{details?.get(value) && (
									<span className="truncate text-xs text-muted-foreground">
										{details.get(value)}
									</span>
								)}
							</span>
							<span className="text-xs tabular-nums text-muted-foreground">
								{formatCount(count)}
							</span>
						</button>
					</li>
				))}
				{shown.length === 0 && (
					<li className="px-2 py-1.5 text-muted-foreground">Nothing matches</li>
				)}
			</ul>
		</>
	);
}

const OPS = ["<", "<=", "=", ">=", ">"] as const;
const OP_LABEL = { "<": "<", "<=": "≤", "=": "=", ">=": "≥", ">": ">" };

// Inventory is whole units and can go negative; velocity is a rate, so it
// takes fractions but not negatives.
const NUMBER = {
	inventory: { pattern: /^-?\d+$/, strip: /[^\d-]/g, placeholder: "Units" },
	velocity: {
		pattern: /^\d+(\.\d+)?$/,
		strip: /[^\d.]/g,
		placeholder: "Units a month",
	},
};

function ComparisonForm({
	field,
	onAdd,
}: {
	field: "inventory" | "velocity";
	onAdd: (f: Omit<Filter, "and" | "exact">) => void;
}) {
	const [op, setOp] = useState<(typeof OPS)[number]>("<");
	const [n, setN] = useState("");
	const number = NUMBER[field];
	function submit(e: FormEvent) {
		e.preventDefault();
		if (!number.pattern.test(n)) return;
		onAdd({ field, value: `${op}${Number(n)}`, exclude: false });
	}
	return (
		<form onSubmit={submit} className="flex flex-col gap-2 p-1">
			<div className="flex gap-1">
				{OPS.map((o) => (
					<button
						key={o}
						type="button"
						onClick={() => setOp(o)}
						className={cn(
							"h-8 flex-1 rounded-lg font-medium",
							op === o ? "bg-primary text-primary-foreground" : "bg-surface",
						)}
					>
						{OP_LABEL[o]}
					</button>
				))}
			</div>
			<input
				// biome-ignore lint/a11y/noAutofocus: the number is the only thing left to give
				autoFocus
				inputMode={field === "velocity" ? "decimal" : "numeric"}
				value={n}
				onChange={(e) => setN(e.target.value.replace(number.strip, ""))}
				placeholder={number.placeholder}
				className="h-8 rounded-lg border border-input px-2 tabular-nums outline-none focus:border-ring focus:ring-1 focus:ring-ring"
			/>
			<button
				type="submit"
				disabled={!number.pattern.test(n)}
				className="h-8 rounded-lg bg-primary font-medium text-white disabled:opacity-40"
			>
				Add filter
			</button>
		</form>
	);
}

function TextForm({
	placeholder,
	onAdd,
}: {
	placeholder: string;
	onAdd: (value: string) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (value.trim()) onAdd(value.trim());
			}}
			className="flex flex-col gap-2 p-1"
		>
			<input
				// biome-ignore lint/a11y/noAutofocus: the word is the only thing left to give
				autoFocus
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder={placeholder}
				className="h-8 rounded-lg border border-input px-2 outline-none focus:border-ring focus:ring-1 focus:ring-ring"
			/>
			<button
				type="submit"
				disabled={!value.trim()}
				className="h-8 rounded-lg bg-primary font-medium text-white disabled:opacity-40"
			>
				Add filter
			</button>
		</form>
	);
}

// Sorts by one column by picking it; picking the column already leading
// flips it. Several columns at once are typed: ^class ^!velocity.
export function SortMenu<K extends string>({
	sort,
	onSort,
	columns,
}: {
	sort: Sort<K>;
	onSort: (sort: Sort<K>) => void;
	columns: SortColumns<K>;
}) {
	const [open, setOpen] = useState(false);
	const lead = sort[0];
	const title = lead
		? `Sort: ${sort.map((t) => describeTerm(t, columns)).join(", then ")}`
		: "Sort";
	function pick(term: SortTerm<K>) {
		onSort([term]);
		setOpen(false);
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			{/* The tip sits inside so the popover's data-state reaches the button. */}
			<PopoverTrigger asChild>
				<Tip content={title}>
					<button
						type="button"
						className={cn(iconButton, lead && "text-foreground")}
						aria-label={title}
					>
						<ArrowUpDown className="size-4" />
					</button>
				</Tip>
			</PopoverTrigger>
			<PopoverContent className="w-72">
				<div className="flex items-center justify-between px-2 py-1">
					<p className="text-xs font-medium text-muted-foreground">Sort by</p>
					{lead && (
						<button
							type="button"
							onClick={() => {
								onSort([]);
								setOpen(false);
							}}
							className="text-xs text-link hover:underline"
						>
							Back to name order
						</button>
					)}
				</div>
				<ul className="max-h-80 overflow-y-auto">
					{(Object.keys(columns) as K[]).map((key) => {
						const at = sort.findIndex((t) => t.key === key);
						const term = sort[at];
						const c = columns[key];
						return (
							<li key={key} className="flex items-center gap-1">
								<span className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2">
									<span className="w-3 text-center text-xs tabular-nums text-muted-foreground">
										{at >= 0 && sort.length > 1 ? at + 1 : ""}
									</span>
									<span className={cn("truncate", term && "font-medium")}>
										{c.label}
									</span>
								</span>
								{([false, true] as const).map((desc) => {
									const Arrow = desc ? ArrowDown : ArrowUp;
									const on = term?.desc === desc;
									return (
										<Tip
											key={String(desc)}
											content={`${c.label}, ${desc ? c.desc : c.asc}`}
										>
											<button
												type="button"
												aria-label={`${c.label}, ${desc ? c.desc : c.asc}`}
												aria-pressed={on}
												onClick={() => pick({ key, desc })}
												className={cn(
													"inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface",
													on &&
														"bg-primary text-primary-foreground hover:bg-primary",
												)}
											>
												<Arrow className="size-4" />
											</button>
										</Tip>
									);
								})}
							</li>
						);
					})}
				</ul>
				<p className="border-t px-2 pt-2 pb-1 text-xs text-muted-foreground">
					<kbd>^</kbd> lowest · <kbd>^!</kbd> highest · later chips break ties
				</p>
			</PopoverContent>
		</Popover>
	);
}
