import { ArrowDown, ArrowUp } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Tip } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";
import { type Sort, withTerm } from "#/products/sort";

// A table header that sorts by its column. A click sorts by it alone, or
// flips it when it already leads; Shift adds it as a tiebreaker, or flips it
// where it is. An arrow shows the direction, and a number its place when
// several columns sort.
export function SortHeader<K extends string>({
	column,
	sort,
	onSort,
	tip = "Shift-click to break ties",
	className,
	children,
}: {
	column: K;
	sort: Sort<K>;
	onSort: (sort: Sort<K>) => void;
	tip?: string;
	className?: string;
	children: ReactNode;
}) {
	const at = sort.findIndex((t) => t.key === column);
	const term = at === -1 ? undefined : sort[at];
	function click(e: MouseEvent) {
		if (e.shiftKey) {
			onSort(withTerm(sort, { key: column, desc: term ? !term.desc : false }));
			return;
		}
		const leads = sort.length === 1 && term;
		onSort([{ key: column, desc: leads ? !term.desc : false }]);
	}
	const Arrow = term?.desc ? ArrowDown : ArrowUp;
	const right = className?.includes("text-right");
	return (
		<th
			className={cn("px-3 py-2 font-medium", className)}
			aria-sort={term ? (term.desc ? "descending" : "ascending") : undefined}
		>
			<Tip content={tip}>
				<button
					type="button"
					onClick={click}
					className={cn(
						"inline-flex items-center gap-1 hover:text-foreground",
						right && "flex-row-reverse",
						term && "text-foreground",
					)}
				>
					{children}
					{term && <Arrow className="size-3" />}
					{term && sort.length > 1 && (
						<span className="tabular-nums">{at + 1}</span>
					)}
				</button>
			</Tip>
		</th>
	);
}
