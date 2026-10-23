import NumberFlow from "@number-flow/react";
import {
	ClipboardList,
	Copy,
	Loader2,
	PackagePlus,
	Truck,
	X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	addAllToPos,
	countAll,
	orderable,
	setCatalogOnAll,
} from "#/components/products-list/bulk-actions";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { Tip } from "#/components/ui/tooltip";
import { copyText } from "#/lib/copy";
import { formatCount } from "#/lib/format";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { ProductRow } from "#/server/catalog";
import { type CatalogRow, listCatalogs } from "#/server/purchasing";

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
				<CatalogPicker
					disabled={running !== null}
					busy={running === "catalog"}
					onPick={(c) => run("catalog", () => setCatalogOnAll(picked, c))}
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

// Which catalog the ticked products are in, which says who sells them.
// Catalogs load the first time it opens.
function CatalogPicker({
	disabled,
	busy,
	onPick,
}: {
	disabled: boolean;
	busy: boolean;
	onPick: (c: { id: number; name: string }) => void;
}) {
	const [open, setOpen] = useState(false);
	const [catalogs, setCatalogs] = useState<CatalogRow[] | null>(null);
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next && catalogs === null) listCatalogs().then(setCatalogs);
			}}
		>
			<PopoverTrigger asChild>
				<BarButton disabled={disabled} busy={busy} icon={<Truck />}>
					Set catalog
				</BarButton>
			</PopoverTrigger>
			<PopoverContent side="top" className="w-72 p-0">
				<Command>
					<CommandInput placeholder="Catalog" />
					<CommandList>
						<CommandEmpty>
							{catalogs === null ? "Loading…" : "No catalog by that name"}
						</CommandEmpty>
						{catalogs?.map((c) => (
							<CommandItem
								key={c.id}
								value={c.name}
								onSelect={() => {
									setOpen(false);
									onPick({ id: c.id, name: c.name });
								}}
							>
								<span className="flex-1 truncate">{c.name}</span>
								<span className="text-xs text-muted-foreground tabular-nums">
									{formatCount(c.products)}
								</span>
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
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
