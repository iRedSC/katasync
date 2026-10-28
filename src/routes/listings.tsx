import { createFileRoute } from "@tanstack/react-router";
import { ChevronRight, Link2 } from "lucide-react";
import { useState } from "react";
import { MatchPicker, resolveItem } from "#/components/match-picker";
import { Card, EmptyState, Page } from "#/components/page";
import { ProductImage } from "#/components/product";
import { ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { formatCount } from "#/lib/format";
import { optimistic } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { listUnmatchedItems } from "#/server/catalog";

export const Route = createFileRoute("/listings")({
	loader: () => listUnmatchedItems({ data: {} }),
	component: Queue,
	pendingComponent: () => <ListSkeleton title="Unmatched" />,
});

type Item = Awaited<ReturnType<typeof listUnmatchedItems>>[number];

const key = (i: Item) => i.listingIds.join("-");

// Resolving an item takes it off the queue at once.
const queueData = optimistic<Item[]>("unmatched");

function Queue() {
	const items = queueData.useData("all", Route.useLoaderData());
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [showUnsold, setShowUnsold] = useState(false);

	const selling = items.filter((i) => i.units > 0);
	const unsold = items.filter((i) => i.units === 0);
	const shown = showUnsold || selling.length === 0 ? items : selling;
	// The chosen item, or the first left once it's been resolved.
	const at = Math.max(
		0,
		shown.findIndex((i) => key(i) === selectedKey),
	);
	const item = shown[at];

	const skip = () => {
		const next = shown[at + 1] ?? shown[0];
		if (next) setSelectedKey(key(next));
	};

	if (items.length === 0)
		return (
			<Page title="Unmatched">
				<Card>
					<EmptyState icon={Link2} title="All matched" />
				</Card>
			</Page>
		);

	const row = (i: Item) => (
		<QueueRow
			key={key(i)}
			item={i}
			selected={i === item}
			onSelect={() => setSelectedKey(key(i))}
		/>
	);

	return (
		<Page title="Unmatched" width="wide">
			<Card flush>
				<div className="grid min-h-[32rem] md:grid-cols-[22rem_minmax(0,1fr)]">
					<nav className="max-h-[75vh] overflow-y-auto border-b md:border-r md:border-b-0">
						{selling.length > 0 && (
							<Section title="Selling" count={selling.length} />
						)}
						{selling.map(row)}
						{unsold.length > 0 && (
							<button
								type="button"
								onClick={() => setShowUnsold((s) => !s)}
								className="w-full text-left hover:bg-subtle"
							>
								<Section
									title="Never sold"
									count={unsold.length}
									open={showUnsold || selling.length === 0}
								/>
							</button>
						)}
						{(showUnsold || selling.length === 0) && unsold.map(row)}
					</nav>
					<div className="p-5">
						{item && (
							<MatchPicker
								item={item}
								onResolve={async (r) => {
									const done = item;
									skip();
									const ok = await resolveItem(
										done,
										r,
										queueData.patch("all", (list) =>
											list.filter((i) => key(i) !== key(done)),
										),
									);
									// A failed one is back on the queue; return to it.
									if (!ok) setSelectedKey(key(done));
									return ok;
								}}
								actions={
									<Button variant="ghost" size="sm" onClick={skip}>
										Skip
									</Button>
								}
							/>
						)}
					</div>
				</div>
			</Card>
		</Page>
	);
}

function Section({
	title,
	count,
	open,
}: {
	title: string;
	count: number;
	open?: boolean;
}) {
	return (
		<div className="flex items-center gap-1 px-4 pt-4 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
			<span className="flex-1">{title}</span>
			<span className="tabular-nums">{formatCount(count)}</span>
			{open !== undefined && (
				<ChevronRight
					className={cn("size-3.5 transition-transform", open && "rotate-90")}
				/>
			)}
		</div>
	);
}

// Shaped like a product row: picture, title, SKU.
function QueueRow({
	item,
	selected,
	onSelect,
}: {
	item: Item;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"flex w-full items-center gap-3 px-4 py-2 text-left",
				selected
					? "bg-surface shadow-[inset_3px_0_var(--ring)]"
					: "hover:bg-subtle",
			)}
		>
			<ProductImage src={null} className="size-8" />
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium">{item.title}</span>
				<span className="block truncate text-xs text-muted-foreground">
					{item.sku ?? "No SKU"}
				</span>
			</span>
			{item.units > 0 && (
				<span className="shrink-0 text-xs font-medium text-critical-text tabular-nums">
					{formatCount(item.units)}
				</span>
			)}
		</button>
	);
}
