import { ArrowUpDown, Check, ChevronLeft, ListFilter } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Field, Filter, facetCounts } from "#/products/search";
import { SORTS, type Sort } from "#/products/views";

// The fields the filter button offers, in the order shown. Each says how to
// type it, so the menu also teaches the search language.
const FIELDS: { field: Field; label: string; typed: string }[] = [
	{ field: "status", label: "Status", typed: "%" },
	{ field: "class", label: "Class", typed: "^" },
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

// Adds a chip by picking instead of typing: a field, then a value.
export function AddFilter({
	counts,
	onAdd,
}: {
	counts: ReturnType<typeof facetCounts>;
	onAdd: (filter: Filter) => void;
}) {
	const [open, setOpen] = useState(false);
	const [field, setField] = useState<Field | null>(null);

	function add(filter: Omit<Filter, "and" | "exact">) {
		onAdd({ ...filter, and: false, exact: filter.field !== "title" });
		setOpen(false);
	}

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setField(null);
			}}
		>
			<PopoverTrigger className={iconButton} aria-label="Add a filter">
				<ListFilter className="size-4" />
			</PopoverTrigger>
			<PopoverContent className="w-72">
				{field === null ? (
					<ul>
						{FIELDS.map((f) => (
							<li key={f.field}>
								<button
									type="button"
									onClick={() => setField(f.field)}
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
							onClick={() => setField(null)}
							className="flex h-8 items-center gap-1 rounded-lg px-1 font-semibold hover:bg-surface"
						>
							<ChevronLeft className="size-4" />
							{FIELDS.find((f) => f.field === field)?.label}
						</button>
						{field === "inventory" || field === "velocity" ? (
							<ComparisonForm key={field} field={field} onAdd={add} />
						) : field === "title" ? (
							<TextForm
								placeholder="Word to leave out"
								onAdd={(value) => add({ field: "title", value, exclude: true })}
							/>
						) : (
							<ValueList
								values={counts.get(field) ?? new Map()}
								onAdd={(value, exclude) => add({ field, value, exclude })}
							/>
						)}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

// Every value of one field, most common first, narrowed by what's typed. All
// of them: a few hundred rows is cheap, and a cut-off list looks complete.
function ValueList({
	values,
	onAdd,
}: {
	values: Map<string, number>;
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
							className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-surface"
						>
							<span className="flex-1 truncate">{value}</span>
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

export function SortMenu({
	sort,
	onSort,
}: {
	sort: Sort;
	onSort: (sort: Sort) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				className={iconButton}
				aria-label={`Sort: ${SORTS[sort]}`}
				title={`Sort: ${SORTS[sort]}`}
			>
				<ArrowUpDown className="size-4" />
			</PopoverTrigger>
			<PopoverContent className="w-56">
				<p className="px-2 py-1 text-xs font-medium text-muted-foreground">
					Sort by
				</p>
				<ul>
					{(Object.keys(SORTS) as Sort[]).map((s) => (
						<li key={s}>
							<button
								type="button"
								onClick={() => {
									onSort(s);
									setOpen(false);
								}}
								className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-surface"
							>
								<Check className={cn("size-4", s !== sort && "invisible")} />
								{SORTS[s]}
							</button>
						</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
