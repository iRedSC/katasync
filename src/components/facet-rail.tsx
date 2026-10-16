import { useState } from "react";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import { comparison, type Filter, type ListField } from "#/products/search";

export type RailGroup =
	| {
			title: string;
			field: ListField;
			// Fixed values in this order, or null to list every value, most
			// common first.
			values: readonly string[] | null;
			// What a value reads as, when not just itself capitalized.
			label?: (value: string) => string;
	  }
	// A min and a max, kept as ">=" and "<=" chips.
	| { title: string; field: "velocity"; range: true };

const SHORT = 6;

// Checkboxes for the common filters, beside the list. Each one is a chip in
// the search box, so the box, saved views, and links all keep working; the
// rail is just a faster way to make and drop them. Counts say how many
// products picking that value would show, given everything else picked.
export function FacetRail({
	groups,
	counts,
	filters,
	onFilters,
}: {
	groups: RailGroup[];
	counts: Map<ListField, Map<string, number>>;
	filters: Filter[];
	onFilters: (next: Filter[]) => void;
}) {
	const picked = (field: ListField, value: string) =>
		filters.some(
			(f) =>
				f.field === field &&
				!f.exclude &&
				f.value.toLowerCase() === value.toLowerCase(),
		);
	// Ticking drops any chip on the same value first, exclusions included,
	// so "not counted" and "counted" can't both be on and empty the list.
	function toggle(field: ListField, value: string) {
		const was = picked(field, value);
		const rest = filters.filter(
			(f) =>
				!(f.field === field && f.value.toLowerCase() === value.toLowerCase()),
		);
		onFilters(
			was
				? rest
				: [...rest, { field, value, exclude: false, and: false, exact: true }],
		);
	}
	return (
		<nav aria-label="Filters" className="flex flex-col gap-5">
			{groups.map((g) =>
				"range" in g ? (
					<Range
						key={g.field + g.title}
						title={g.title}
						filters={filters}
						onFilters={onFilters}
					/>
				) : (
					<Group
						key={g.field + g.title}
						group={g}
						counts={counts.get(g.field) ?? new Map()}
						pickedValues={filters
							.filter((f) => f.field === g.field && !f.exclude)
							.map((f) => f.value)}
						picked={(v) => picked(g.field, v)}
						onToggle={(v) => toggle(g.field, v)}
					/>
				),
			)}
		</nav>
	);
}

function Group({
	group: g,
	counts,
	pickedValues,
	picked,
	onToggle,
}: {
	group: Extract<RailGroup, { values: unknown }>;
	counts: Map<string, number>;
	// Picked values with no products left still need a box to untick.
	pickedValues: string[];
	picked: (value: string) => boolean;
	onToggle: (value: string) => void;
}) {
	const [all, setAll] = useState(false);
	// Fixed lists keep their order and every value, so the choices don't
	// jump around; open lists sort by count and drop values with no products
	// unless picked, so a pick can always be undone here.
	const values =
		g.values ??
		[
			...new Set([
				...counts.keys(),
				...pickedValues.filter(
					(v) =>
						![...counts.keys()].some(
							(k) => k.toLowerCase() === v.toLowerCase(),
						),
				),
			]),
		]
			.sort(
				(a, b) =>
					(counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b),
			)
			.filter((v) => (counts.get(v) ?? 0) > 0 || picked(v));
	if (values.length === 0) return null;
	// Picked values stay visible even when the list is cut short.
	const shown = all ? values : values.filter((v, i) => i < SHORT || picked(v));
	return (
		<section>
			<h2 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
				{g.title}
			</h2>
			<ul className="flex flex-col">
				{shown.map((v) => (
					<li key={v}>
						<label
							className={cn(
								"flex h-7 cursor-pointer items-center gap-2 rounded-lg px-1.5 hover:bg-surface",
								!counts.get(v) && !picked(v) && "text-muted-foreground",
							)}
						>
							<input
								type="checkbox"
								checked={picked(v)}
								onChange={() => onToggle(v)}
								className="size-3.5 shrink-0 accent-primary"
							/>
							<span className="min-w-0 flex-1 truncate">
								{g.label ? g.label(v) : capitalize(v)}
							</span>
							<span className="text-xs text-muted-foreground tabular-nums">
								{formatCount(counts.get(v) ?? 0)}
							</span>
						</label>
					</li>
				))}
			</ul>
			{values.length > shown.length || all ? (
				<button
					type="button"
					onClick={() => setAll((a) => !a)}
					className={cn(
						"mt-0.5 px-1.5 text-xs font-medium text-link hover:underline",
						values.length <= SHORT && "hidden",
					)}
				>
					{all ? "Show fewer" : `Show all ${formatCount(values.length)}`}
				</button>
			) : null}
		</section>
	);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Bound = ">=" | "<=";
const NUMBER = /^\d+(\.\d+)?$/;

// Min and max boxes for velocity. Each box owns one chip: ">=" for min, "<="
// for max. Other velocity chips typed in the search box are left alone.
function Range({
	title,
	filters,
	onFilters,
}: {
	title: string;
	filters: Filter[];
	onFilters: (next: Filter[]) => void;
}) {
	const bound = (op: Bound) => {
		const f = filters.find(
			(f) => f.field === "velocity" && comparison(f.value)?.op === op,
		);
		return f ? String(comparison(f.value)?.n) : "";
	};
	// Empty clears the bound; anything else only lands once it's a number.
	function set(op: Bound, text: string) {
		if (text !== "" && !NUMBER.test(text)) return;
		const rest = filters.filter(
			(f) => !(f.field === "velocity" && comparison(f.value)?.op === op),
		);
		onFilters(
			text === ""
				? rest
				: [
						...rest,
						{
							field: "velocity",
							value: `${op}${Number(text)}`,
							exclude: false,
							and: false,
							exact: true,
						},
					],
		);
	}
	const min = bound(">=");
	const max = bound("<=");
	return (
		<section>
			<h2 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
				{title}
			</h2>
			<div className="flex items-center gap-1.5 px-1.5">
				<BoundBox label="Min" value={min} onValue={(t) => set(">=", t)} />
				<span className="text-muted-foreground">to</span>
				<BoundBox label="Max" value={max} onValue={(t) => set("<=", t)} />
			</div>
			<p className="mt-1 px-1.5 text-xs text-muted-foreground">Sold a month</p>
			{min !== "" && max !== "" && Number(min) > Number(max) && (
				<p className="mt-1 px-1.5 text-xs text-destructive">
					Min is above max, so nothing matches.
				</p>
			)}
		</section>
	);
}

// Shows the chip's number, but holds what's being typed ("0.") until the
// box loses focus, so a half-typed number isn't wiped by the round trip.
function BoundBox({
	label,
	value,
	onValue,
}: {
	label: string;
	value: string;
	onValue: (text: string) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<input
			aria-label={`${label} sold a month`}
			placeholder={label}
			inputMode="decimal"
			value={draft ?? value}
			onChange={(e) => {
				const text = e.target.value.replace(/[^\d.]/g, "");
				setDraft(text);
				onValue(text);
			}}
			onBlur={() => setDraft(null)}
			className="h-7 w-full min-w-0 rounded-lg border border-input bg-white px-2 tabular-nums outline-none focus:border-ring focus:ring-1 focus:ring-ring"
		/>
	);
}
