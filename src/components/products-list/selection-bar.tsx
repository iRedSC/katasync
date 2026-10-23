import NumberFlow from "@number-flow/react";
import {
	ClipboardList,
	Copy,
	Library,
	Loader2,
	PackagePlus,
	X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { AddToCatalog } from "#/components/products-list/add-to-catalog";
import {
	addAllToPos,
	countAll,
	orderable,
	setCatalogOnAll,
} from "#/components/products-list/bulk-actions";
import { Tip } from "#/components/ui/tooltip";
import { copyText } from "#/lib/copy";
import { formatCount } from "#/lib/format";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { ProductRow } from "#/server/catalog";

type Running = "po" | "count" | "catalog" | null;

// Floats at the foot of the page while anything is ticked, with what can be
// done to all of it at once.
export function SelectionBar({
	picked,
	onClear,
}: {
	picked: ProductRow[];
	onClear: () => void;
}) {
	const [running, setRunning] = useState<Running>(null);
	const canOrder = picked.filter(orderable).length;

	async function run(
		what: Exclude<Running, null>,
		action: () => Promise<void>,
	) {
		setRunning(what);
		try {
			await action();
		} finally {
			setRunning(null);
		}
	}

	return (
		<div
			className={cn(
				"pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-4 transition-all duration-200",
				picked.length > 0
					? "translate-y-0 opacity-100"
					: "translate-y-6 opacity-0",
			)}
		>
			<div
				className={cn(
					"flex items-center gap-1 rounded-xl bg-topbar p-1.5 pl-4 text-sm text-white shadow-lg",
					picked.length > 0 && "pointer-events-auto",
				)}
			>
				<span className="mr-2 flex items-center gap-1 font-medium tabular-nums">
					<NumberFlow value={picked.length} />
					<span className="text-white/60">selected</span>
				</span>
				<Tip
					content={
						canOrder === 0
							? "None have a supplier and are off drafts"
							: canOrder < picked.length
								? `${formatCount(picked.length - canOrder)} left out: on a draft already or no supplier`
								: undefined
					}
				>
					<BarButton
						disabled={canOrder === 0 || running !== null}
						busy={running === "po"}
						onClick={() => run("po", () => addAllToPos(picked))}
						icon={<PackagePlus />}
					>
						Add{" "}
						{canOrder > 0 && canOrder < picked.length && formatCount(canOrder)}{" "}
						to POs
					</BarButton>
				</Tip>
				<AddToCatalog
					picked={picked}
					disabled={running !== null}
					busy={running === "catalog"}
					onAdd={(c) => run("catalog", () => setCatalogOnAll(picked, c))}
					trigger={(t) => (
						<BarButton {...t} icon={<Library />}>
							Add to catalog
						</BarButton>
					)}
				/>
				<BarButton
					disabled={running !== null}
					busy={running === "count"}
					onClick={() => run("count", () => countAll(picked))}
					icon={<ClipboardList />}
				>
					Count
				</BarButton>
				<BarButton
					onClick={() =>
						copyText(
							picked.map((p) => p.sku).join("\n"),
							`${formatCount(picked.length)} SKUs`,
						)
					}
					icon={<Copy />}
				>
					Copy SKUs
				</BarButton>
				<Tip content="Untick all">
					<button
						type="button"
						aria-label="Untick all"
						onClick={onClear}
						className="ml-1 rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
					>
						<X className="size-4" />
					</button>
				</Tip>
			</div>
		</div>
	);
}

function BarButton({
	icon,
	busy = false,
	children,
	...props
}: {
	icon: ReactNode;
	busy?: boolean;
	children: ReactNode;
} & React.ComponentProps<"button">) {
	return (
		<button
			type="button"
			{...props}
			className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 font-medium whitespace-nowrap hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-4"
		>
			{busy ? <Loader2 className="animate-spin" /> : icon}
			{children}
		</button>
	);
}

// Unticks everything, with an undo: a long hand-picked selection is work.
export function clearWithUndo(
	selected: ReadonlySet<number>,
	onSelected: (next: ReadonlySet<number>) => void,
) {
	onSelected(new Set());
	offerUndo(`Unticked ${formatCount(selected.size)}`, {
		undo: async () => {
			onSelected(selected);
			return null;
		},
	});
}
