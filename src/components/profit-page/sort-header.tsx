import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "#/lib/utils";
import type { SortKey } from "./sorting";

// A column to sort by, and maybe a second one shown in the same cell (a
// profit's margin).
export function Th({
	sort,
	by,
	onSort,
	right,
	also,
	children,
}: {
	sort: { key: SortKey; desc: boolean };
	by: SortKey;
	onSort: (key: SortKey) => void;
	right?: boolean;
	also?: [SortKey, string];
	children: ReactNode;
}) {
	const Arrow = sort.desc ? ArrowDown : ArrowUp;
	const button = (key: SortKey, label: ReactNode) => (
		<button
			type="button"
			onClick={() => onSort(key)}
			className={cn(
				"inline-flex items-center gap-1 hover:text-foreground",
				sort.key === key && "text-foreground",
			)}
		>
			{label}
			{sort.key === key && <Arrow className="size-3" />}
		</button>
	);
	const sorted = sort.key === by || sort.key === also?.[0];
	return (
		<th
			className={cn("px-2.5 py-2 font-medium", right && "text-right")}
			aria-sort={sorted ? (sort.desc ? "descending" : "ascending") : undefined}
		>
			{button(by, children)}
			{also && (
				<>
					<span className="mx-1">·</span>
					{button(also[0], also[1])}
				</>
			)}
		</th>
	);
}
