import { useState } from "react";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Filter, ListField } from "#/products/search";

export type RailGroup = {
	title: string;
	field: ListField;
	// Fixed values in this order, or null to list every value, most common
	// first.
	values: readonly string[] | null;
	// What a value reads as, when not just itself capitalized.
	label?: (value: string) => string;
};

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
	function toggle(field: ListField, value: string) {
		onFilters(
			picked(field, value)
				? filters.filter(
						(f) =>
							!(
								f.field === field &&
								!f.exclude &&
								f.value.toLowerCase() === value.toLowerCase()
							),
					)
				: [
						...filters,
						{ field, value, exclude: false, and: false, exact: true },
					],
		);
	}
	return (
		<nav aria-label="Filters" className="flex flex-col gap-5">
			{groups.map((g) => (
				<Group
					key={g.field + g.title}
					group={g}
					counts={counts.get(g.field) ?? new Map()}
					picked={(v) => picked(g.field, v)}
					onToggle={(v) => toggle(g.field, v)}
				/>
			))}
		</nav>
	);
}

function Group({
	group: g,
	counts,
	picked,
	onToggle,
}: {
	group: RailGroup;
	counts: Map<string, number>;
	picked: (value: string) => boolean;
	onToggle: (value: string) => void;
}) {
	const [all, setAll] = useState(false);
	// Fixed lists keep their order; open lists sort by count. Values with no
	// products drop out unless picked, so a pick can always be undone here.
	const values = (
		g.values ??
		[...counts.keys()].sort(
			(a, b) =>
				(counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b),
		)
	).filter((v) => (counts.get(v) ?? 0) > 0 || picked(v));
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
						<label className="flex h-7 cursor-pointer items-center gap-2 rounded-lg px-1.5 hover:bg-surface">
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
