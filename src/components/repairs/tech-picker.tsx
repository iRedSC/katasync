import { cn } from "#/lib/utils";
import type { Person } from "#/repairs/people";
import { colorOf } from "./person-chip";

// Who has the tool: one of the technicians from Settings, or nobody yet.
// Tapping the one already chosen takes it off them.
export function TechPicker({
	people,
	value,
	onChange,
}: {
	people: Person[];
	value: number | null;
	onChange: (id: number | null) => void;
}) {
	const techs = people.filter((p) => p.technician || p.id === value);
	if (techs.length === 0)
		return (
			<p className="text-muted-foreground">
				Add technicians under Settings, People.
			</p>
		);
	return (
		<div className="flex flex-wrap gap-2">
			{techs.map((p) => (
				<button
					key={p.id}
					type="button"
					aria-pressed={value === p.id}
					onClick={() => onChange(value === p.id ? null : p.id)}
					className={cn(
						"h-8 rounded-full px-3 font-semibold transition-all",
						value === p.id
							? cn(colorOf(p.id), "ring-2 ring-current")
							: "bg-surface-strong text-muted-foreground hover:text-foreground",
					)}
				>
					{p.name}
				</button>
			))}
		</div>
	);
}
