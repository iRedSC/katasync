import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge, Card, EmptyState, Page } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "#/components/ui/dialog";
import { channelName, formatCount } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";
import {
	createListingProduct,
	listProductIndex,
	listUnmappedListings,
	matchListing,
} from "#/server/catalog";

export const Route = createFileRoute("/listings")({
	loader: () => listUnmappedListings(),
	component: Listings,
});

type Listing = Awaited<ReturnType<typeof listUnmappedListings>>[number];

function Listings() {
	const rows = Route.useLoaderData();
	const router = useRouter();
	const [selected, setSelected] = useState(0);
	const [matching, setMatching] = useState<Listing | null>(null);
	const [busy, setBusy] = useState<number | null>(null);

	useEffect(() => {
		setSelected((i) => Math.min(i, Math.max(rows.length - 1, 0)));
	}, [rows.length]);

	async function done(
		listing: Listing,
		action: Promise<{ sku: string; ordersUpdated: number }>,
		verb: string,
	) {
		setBusy(listing.id);
		try {
			const { sku, ordersUpdated } = await action;
			await router.invalidate();
			toast.success(`${verb} ${sku}`, {
				description:
					ordersUpdated > 0
						? `${formatCount(ordersUpdated)} past order ${ordersUpdated === 1 ? "line" : "lines"} updated`
						: listing.title,
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(null);
		}
	}

	const create = (l: Listing | undefined) =>
		l &&
		done(l, createListingProduct({ data: { listingId: l.id } }), "Created");

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
					<EmptyState icon={Link2} title="Every listing has a product">
						When a store adds a listing katasync can't match on its own, it
						shows up here.
					</EmptyState>
				</Card>
			) : (
				<>
					<p className="-mt-2 text-muted-foreground">
						These listings sell something katasync doesn't know yet, so their
						sales can't take stock. Create the product if it's new, or match it
						to one you already have. Most-sold first.
					</p>
					<Card flush>
						<ul>
							{rows.map((l, i) => (
								<li
									key={l.id}
									onMouseMove={() => setSelected(i)}
									className={cn(
										"flex items-center gap-4 border-t px-4 py-3 first:border-t-0",
										i === selected && "bg-[#f1f1f1]",
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
											disabled={busy === l.id}
											onClick={() => setMatching(l)}
										>
											Match existing
										</Button>
										<Button
											size="sm"
											disabled={busy === l.id}
											onClick={() => create(l)}
										>
											Create product
										</Button>
									</div>
								</li>
							))}
						</ul>
					</Card>
					<p className="text-xs text-muted-foreground">
						Keyboard: J and K to move, C to create, M to match.
					</p>
				</>
			)}

			<MatchDialog
				listing={matching}
				onClose={() => setMatching(null)}
				onPick={(listing, sku) => {
					setMatching(null);
					done(
						listing,
						matchListing({ data: { listingId: listing.id, sku } }),
						"Matched to",
					);
				}}
			/>
		</Page>
	);
}

type IndexEntry = Awaited<ReturnType<typeof listProductIndex>>[number];

function MatchDialog({
	listing,
	onClose,
	onPick,
}: {
	listing: Listing | null;
	onClose: () => void;
	onPick: (listing: Listing, sku: string) => void;
}) {
	const [index, setIndex] = useState<IndexEntry[] | null>(null);
	const [query, setQuery] = useState("");

	useEffect(() => {
		if (listing && index === null) listProductIndex().then(setIndex);
		// Start from the listing's SKU, which is usually close to the right one.
		if (listing) setQuery(listing.externalSku?.split(/[-_ ]/)[0] ?? "");
	}, [listing, index]);

	const q = query.trim().toLowerCase();
	const matches =
		!index || q.length < 2
			? []
			: index
					.filter(
						(p) =>
							p.sku.toLowerCase().includes(q) ||
							p.name.toLowerCase().includes(q),
					)
					.slice(0, 40);

	return (
		<Dialog open={listing !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="overflow-hidden p-0" showCloseButton={false}>
				<DialogTitle className="sr-only">Match listing</DialogTitle>
				<DialogDescription className="border-b px-4 py-3 text-foreground">
					<span className="font-semibold">Match</span>{" "}
					<span className="text-muted-foreground">{listing?.title}</span>
				</DialogDescription>
				<Command shouldFilter={false}>
					<CommandInput
						placeholder="Search products by SKU or name"
						value={query}
						onValueChange={setQuery}
					/>
					<CommandList>
						<CommandEmpty>No products match.</CommandEmpty>
						{matches.length > 0 && (
							<CommandGroup>
								{matches.map((p) => (
									<CommandItem
										key={p.sku}
										value={p.sku}
										onSelect={() => listing && onPick(listing, p.sku)}
									>
										<span className="truncate">
											{p.name}
											{p.variantName && (
												<span className="text-muted-foreground">
													{" "}
													{p.variantName}
												</span>
											)}
										</span>
										<span className="ml-auto shrink-0 text-xs text-muted-foreground">
											{p.sku}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						)}
					</CommandList>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
