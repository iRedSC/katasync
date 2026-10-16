import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	ClipboardList,
	Copy,
	ExternalLink,
	ListChecks,
	Package,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CountDialog } from "#/components/count-dialog";
import { AbcBadge, Card, EmptyState, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { Button } from "#/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { copyText } from "#/lib/copy";
import { formatCount, formatDay } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimistic } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { listCountsDue } from "#/server/catalog";

export const Route = createFileRoute("/counts")({
	loader: () => listCountsDue(),
	component: CycleCounts,
});

type Shelf = Awaited<ReturnType<typeof listCountsDue>>[number];

// The shelves due, as counting them changes the list.
const shelvesData = optimistic<Shelf[]>("counts");

const sameShelf = (a: Shelf, b: Shelf) =>
	a.productId === b.productId && a.locationId === b.locationId;

// Shelves someone asked to have counted, most valuable first. A count that
// matches still clears it.
function CycleCounts() {
	const loaded = Route.useLoaderData();
	const shelves = shelvesData.useData("all", loaded);
	const list = useRef<HTMLTableSectionElement>(null);
	const [selected, setSelected] = useState(0);
	const [counting, setCounting] = useState<Shelf | null>(null);
	const [menuFor, setMenuFor] = useState<Shelf | null>(null);
	const last = shelves.length - 1;

	// Counting a shelf takes it off the list; undo puts it back where it was.
	function countChange(shelf: Shelf) {
		const at = shelves.findIndex((s) => sameShelf(s, shelf));
		const where = at < 0 ? shelves.length : at;
		return {
			patch: shelvesData.patch("all", (list) =>
				list.filter((s) => !sameShelf(s, shelf)),
			),
			undo: shelvesData.patch("all", (list) =>
				list.some((s) => sameShelf(s, shelf))
					? list
					: [...list.slice(0, where), shelf, ...list.slice(where)],
			),
		};
	}

	useEffect(() => {
		list.current
			?.querySelector(`[data-index="${selected}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	// Counting removes the row, so keep the selection on the list.
	useEffect(() => setSelected((i) => Math.min(i, Math.max(last, 0))), [last]);

	useHotkeys({
		j: () => setSelected((i) => Math.min(i + 1, last)),
		k: () => setSelected((i) => Math.max(i - 1, 0)),
		Enter: () => shelves[selected] && setCounting(shelves[selected]),
		c: () => shelves[selected] && setCounting(shelves[selected]),
	});

	const byClass = (abc: "A" | "B" | "C") =>
		shelves.filter((s) => (s.abc ?? "C") === abc).length;

	return (
		<Page title="Cycle counts">
			<p className="-mt-2 text-muted-foreground">
				Shelves someone asked to have counted, most valuable first. Count the
				top of the list first.
			</p>
			<Card
				flush
				title={
					shelves.length === 0
						? "Nothing due"
						: `${formatCount(shelves.length)} ${shelves.length === 1 ? "shelf" : "shelves"} due`
				}
				aside={
					shelves.length > 0 && (
						<span className="flex items-center gap-3">
							{(["A", "B", "C"] as const).map((abc) => (
								<span key={abc} className="flex items-center gap-1.5">
									<AbcBadge abc={abc} />
									<span className="tabular-nums">
										{formatCount(byClass(abc))}
									</span>
								</span>
							))}
						</span>
					)
				}
			>
				{shelves.length === 0 ? (
					<EmptyState icon={ListChecks} title="Every shelf is counted">
						Shelves show up here when someone asks for a count.
					</EmptyState>
				) : (
					<table className="w-full">
						<thead>
							<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
								<th className="px-4 py-2 font-medium">Product</th>
								<th className="px-2 py-2 text-center font-medium">Class</th>
								<th className="hidden px-4 py-2 font-medium md:table-cell">
									Location
								</th>
								<th className="px-4 py-2 font-medium">Last counted</th>
								<th className="px-4 py-2" />
							</tr>
						</thead>
						{/* One menu for the whole table: it acts on the row that was
						    right-clicked. */}
						<ContextMenu>
							<ContextMenuTrigger asChild>
								<tbody ref={list}>
									{shelves.map((s, i) => (
										<tr
											key={`${s.productId}-${s.locationId}`}
											data-index={i}
											onMouseMove={() => setSelected(i)}
											onContextMenu={() => setMenuFor(s)}
											className={cn(
												"border-t first:border-t-0",
												i === selected && "bg-surface",
											)}
										>
											<td className="w-full max-w-0 px-4 py-2">
												<Link
													to="/products/$sku"
													params={{ sku: s.sku }}
													className="flex items-center gap-3"
												>
													<ProductImage src={s.imageUrl} className="size-9" />
													<div className="min-w-0 flex-1">
														<ProductName
															name={s.name}
															variantName={s.variantName}
														/>
														<div className="text-xs text-muted-foreground">
															{s.sku}
														</div>
													</div>
												</Link>
											</td>
											<td className="px-2 py-2 text-center">
												<AbcBadge
													abc={s.abc}
													title={
														s.abc ? undefined : "Needs a cost to get a class"
													}
												/>
											</td>
											<td className="hidden px-4 py-2 whitespace-nowrap md:table-cell">
												{s.location}
											</td>
											<td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
												{s.lastCountedAt ? formatDay(s.lastCountedAt) : "Never"}
											</td>
											<td className="px-4 py-2">
												<Button
													variant="outline"
													size="sm"
													onClick={() => setCounting(s)}
												>
													Count
												</Button>
											</td>
										</tr>
									))}
								</tbody>
							</ContextMenuTrigger>
							{menuFor && <ShelfMenu shelf={menuFor} onCount={setCounting} />}
						</ContextMenu>
					</table>
				)}
			</Card>

			{counting && (
				<CountDialog
					key={`${counting.productId}-${counting.locationId}`}
					open
					onOpenChange={(open) => !open && setCounting(null)}
					sku={counting.sku}
					name={counting.name}
					locations={[{ id: counting.locationId, name: counting.location }]}
					onHandByLocation={new Map([[counting.location, counting.onHand]])}
					patch={() => countChange(counting)}
				/>
			)}
		</Page>
	);
}

// Same dialog as the Count button, so a right-clicked shelf counts the same way.
function ShelfMenu({
	shelf: s,
	onCount,
}: {
	shelf: Shelf;
	onCount: (shelf: Shelf) => void;
}) {
	const navigate = useNavigate();
	const url = `/products/${encodeURIComponent(s.sku)}`;

	return (
		<ContextMenuContent>
			<ContextMenuItem onSelect={() => onCount(s)} shortcut="C">
				<ClipboardList />
				Count this shelf…
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				onSelect={() =>
					navigate({ to: "/products/$sku", params: { sku: s.sku } })
				}
			>
				<Package />
				Open product
			</ContextMenuItem>
			<ContextMenuItem onSelect={() => window.open(url, "_blank")}>
				<ExternalLink />
				Open product in new tab
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onSelect={() => copyText(s.sku)}>
				<Copy />
				Copy SKU
			</ContextMenuItem>
		</ContextMenuContent>
	);
}
