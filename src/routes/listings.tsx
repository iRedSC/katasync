import { createFileRoute } from "@tanstack/react-router";
import { Copy, Link2, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge, Card, EmptyState, Page } from "#/components/page";
import { ProductSearchDialog } from "#/components/product-search-dialog";
import { ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { copyText } from "#/lib/copy";
import { channelName, formatCount } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism, optimistic } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import {
	createListingProduct,
	listUnmappedListings,
	matchListing,
} from "#/server/catalog";

export const Route = createFileRoute("/listings")({
	loader: () => listUnmappedListings(),
	component: Listings,
	pendingComponent: () => <ListSkeleton title="Unmatched listings" />,
});

type Listing = Awaited<ReturnType<typeof listUnmappedListings>>[number];

// Matching a listing or making it a product takes it off this list at once.
const listingsData = optimistic<Listing[]>("listings");

function Listings() {
	const rows = listingsData.useData("all", Route.useLoaderData());
	const [selected, setSelected] = useState(0);
	const [matching, setMatching] = useState<Listing | null>(null);
	const [menuFor, setMenuFor] = useState<Listing | null>(null);

	useEffect(() => {
		setSelected((i) => Math.min(i, Math.max(rows.length - 1, 0)));
	}, [rows.length]);

	// The listing is mapped by the server, so it leaves the list. If the server
	// refuses, it comes back and the engine says why.
	async function resolve(
		listing: Listing,
		{
			label,
			verb,
			send,
		}: {
			label: string;
			verb: string;
			send: () => Promise<{ sku: string; ordersUpdated: number }>;
		},
	) {
		const r = await optimism.change({
			label,
			patch: listingsData.patch("all", (list) =>
				list.filter((l) => l.id !== listing.id),
			),
			send,
		});
		if (!r) return;
		const { sku, ordersUpdated } = r.value;
		toast.success(`${verb} ${sku}`, {
			description:
				ordersUpdated > 0
					? `${formatCount(ordersUpdated)} past order ${ordersUpdated === 1 ? "line" : "lines"} updated`
					: listing.title,
		});
	}

	const create = (l: Listing | undefined) =>
		l &&
		resolve(l, {
			label: `Creating ${l.title}`,
			verb: "Created",
			send: () => createListingProduct({ data: { listingId: l.id } }),
		});

	useHotkeys({
		j: () => setSelected((i) => Math.min(i + 1, rows.length - 1)),
		k: () => setSelected((i) => Math.max(i - 1, 0)),
		c: () => create(rows[selected]),
		m: () => rows[selected] && setMatching(rows[selected]),
	});

	return (
		<Page title="Unmatched listings">
			{rows.length === 0 ? (
				<Card>
					<EmptyState icon={Link2} title="All matched" />
				</Card>
			) : (
				<>
					<p className="-mt-2 text-muted-foreground">
						Their sales take no stock until matched.
					</p>
					<Card flush>
						{/* One menu for the whole list: it acts on the row that was
						    right-clicked. */}
						<ContextMenu>
							<ContextMenuTrigger asChild>
								<ul>
									{rows.map((l, i) => (
										<li
											key={l.id}
											onMouseMove={() => setSelected(i)}
											onContextMenu={() => setMenuFor(l)}
											className={cn(
												"flex items-center gap-4 border-t px-4 py-3 first:border-t-0",
												i === selected && "bg-surface",
											)}
										>
											<div className="min-w-0 flex-1">
												<div className="truncate font-medium">{l.title}</div>
												<div className="flex gap-2 text-xs text-muted-foreground">
													<span>{l.externalSku}</span>
													<span>{channelName(l.channel)}</span>
												</div>
											</div>
											{l.unitsSold > 0 && (
												<Badge tone="warning">
													{formatCount(l.unitsSold)} sold
												</Badge>
											)}
											<div className="flex shrink-0 gap-2">
												<Button
													variant="outline"
													size="sm"
													onClick={() => setMatching(l)}
												>
													Match existing
												</Button>
												<Button size="sm" onClick={() => create(l)}>
													Create product
												</Button>
											</div>
										</li>
									))}
								</ul>
							</ContextMenuTrigger>
							{menuFor && (
								<ListingMenu
									listing={menuFor}
									onMatch={() => setMatching(menuFor)}
									onCreate={() => create(menuFor)}
								/>
							)}
						</ContextMenu>
					</Card>
					<p className="text-xs text-muted-foreground">
						J K move · C create · M match
					</p>
				</>
			)}

			<ProductSearchDialog
				title={
					matching && (
						<>
							<span className="font-semibold">Match</span>{" "}
							<span className="text-muted-foreground">{matching.title}</span>
						</>
					)
				}
				startFrom={matching?.externalSku}
				onClose={() => setMatching(null)}
				onPick={({ sku }) => {
					const listing = matching;
					setMatching(null);
					if (!listing) return;
					resolve(listing, {
						label: `Matching ${listing.title}`,
						verb: "Matched to",
						send: () => matchListing({ data: { listingId: listing.id, sku } }),
					});
				}}
			/>
		</Page>
	);
}

// The same actions as the row's buttons, plus copying its SKU.
function ListingMenu({
	listing,
	onMatch,
	onCreate,
}: {
	listing: Listing;
	onMatch: () => void;
	onCreate: () => void;
}) {
	return (
		<ContextMenuContent>
			<ContextMenuItem onSelect={onMatch} shortcut="M">
				<Link2 />
				Match to existing product…
			</ContextMenuItem>
			<ContextMenuItem onSelect={onCreate} shortcut="C">
				<Plus />
				Create product
			</ContextMenuItem>
			{listing.externalSku && (
				<>
					<ContextMenuSeparator />
					<ContextMenuItem
						onSelect={() => copyText(listing.externalSku ?? "", "SKU")}
					>
						<Copy />
						Copy listing SKU
					</ContextMenuItem>
				</>
			)}
		</ContextMenuContent>
	);
}
