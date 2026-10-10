import { createFileRoute, Link } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CountDialog } from "#/components/count-dialog";
import { AbcBadge, Card, EmptyState, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { Button } from "#/components/ui/button";
import { formatCount, formatDay } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";
import { listCountsDue } from "#/server/catalog";

export const Route = createFileRoute("/counts")({
	loader: () => listCountsDue(),
	component: CycleCounts,
});

type Shelf = Awaited<ReturnType<typeof listCountsDue>>[number];

// Shelves due for counting, most valuable first: A every month, B every
// quarter, C every year. A count that matches still clears it.
function CycleCounts() {
	const shelves = Route.useLoaderData();
	const list = useRef<HTMLTableSectionElement>(null);
	const [selected, setSelected] = useState(0);
	const [counting, setCounting] = useState<Shelf | null>(null);
	const last = shelves.length - 1;

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
				A items are counted every month, B every quarter, C every year. Count
				the top of the list first.
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
						New ones come due as their month, quarter, or year runs out.
					</EmptyState>
				) : (
					<table className="w-full">
						<thead>
							<tr className="border-y bg-[#f7f7f7] text-left text-xs text-muted-foreground">
								<th className="px-4 py-2 font-medium">Product</th>
								<th className="px-2 py-2 text-center font-medium">Class</th>
								<th className="hidden px-4 py-2 font-medium md:table-cell">
									Location
								</th>
								<th className="px-4 py-2 font-medium">Last counted</th>
								<th className="px-4 py-2" />
							</tr>
						</thead>
						<tbody ref={list}>
							{shelves.map((s, i) => (
								<tr
									key={`${s.productId}-${s.locationId}`}
									data-index={i}
									onMouseMove={() => setSelected(i)}
									className={cn(
										"border-t first:border-t-0",
										i === selected && "bg-[#f1f1f1]",
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
											title={s.abc ? undefined : "Needs a cost to get a class"}
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
				/>
			)}
		</Page>
	);
}
