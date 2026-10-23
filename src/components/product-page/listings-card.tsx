import { ArrowRightLeft, MoreHorizontal, Trash2, Unlink } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Badge, Card } from "#/components/page";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { Tip } from "#/components/ui/tooltip";
import { channelName } from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { ProductDetail } from "#/server/catalog";
import {
	deleteListing,
	relinkListing,
	unlinkListing,
} from "#/server/catalog/listing-fixes";
import { ProductSearch } from "./product-search";

type Listing = ProductDetail["listings"][number];
type Product = ProductDetail["product"];

// The product page's data, patched under the same key as the page's own.
const productData = optimistic<ProductDetail>("product");

// The listing leaves this product's page, or comes back to it.
const without = (productId: number, listingId: number) =>
	productData.patch(productId, (d) => ({
		...d,
		listings: d.listings.filter((l) => l.id !== listingId),
	}));
const withListing = (productId: number, listing: Listing) =>
	productData.patch(productId, (d) => ({
		...d,
		listings: d.listings.some((l) => l.id === listing.id)
			? d.listings
			: [...d.listings, listing],
	}));

// Why unlinking would be refused: the listing's SKU names this product, so
// the SKU pass a sync runs matches it straight back (autoMapListings). An
// archived product, or an FBA listing of a tool set, is never matched by
// SKU, so those can go.
function rematches(p: Product, aliases: string[], l: Listing) {
	const sku = l.externalSku?.trim();
	if (!sku || p.archivedAt) return false;
	if (l.fulfillment === "fba" && p.kind === "bundle") return false;
	return sku.toLowerCase() === p.sku.toLowerCase() || aliases.includes(sku);
}

// Moving the listing back here undoes an unlink or relink. An archived
// product can't take listings, so it isn't offered there.
function offerBack(p: Product, l: Listing, message: string) {
	if (p.archivedAt) return toast.success(message);
	offerUndo(message, {
		tone: "success",
		undo: async () => {
			const undone = await optimism.change({
				label: `Moving ${l.title} back`,
				patch: withListing(p.id, l),
				send: () => relinkListing({ data: { listingId: l.id, sku: p.sku } }),
			});
			return undone && `${l.title} sells ${p.sku} again`;
		},
	});
}

async function unlink(p: Product, l: Listing) {
	const r = await optimism.change({
		label: `Unlinking ${l.title}`,
		patch: without(p.id, l.id),
		send: () => unlinkListing({ data: { listingId: l.id } }),
	});
	if (!r) return;
	const { now, problems } = r.value;
	if (problems.length > 0)
		toast.warning("Stock not taken for some orders", {
			description: problems.join(". "),
		});
	offerBack(
		p,
		l,
		now.kind === "matched"
			? `${l.title} → ${now.sku}`
			: now.kind === "new_product_next_sync"
				? `${l.title} becomes ${now.sku} next sync`
				: `${l.title} unmatched${now.why ? `: ${now.why}` : ""}`,
	);
}

async function relink(p: Product, l: Listing, sku: string) {
	const r = await optimism.change({
		label: `Relinking ${l.title}`,
		patch: without(p.id, l.id),
		send: () => relinkListing({ data: { listingId: l.id, sku } }),
	});
	if (r) offerBack(p, l, `${l.title} → ${sku}`);
}

// Nothing to undo with: it's gone from its channel and never sold, so
// nothing is lost.
async function remove(p: Product, l: Listing) {
	const r = await optimism.change({
		label: `Deleting ${l.title}`,
		patch: without(p.id, l.id),
		send: () => deleteListing({ data: { listingId: l.id } }),
	});
	if (r) toast.success(`${l.title} deleted`);
}

// Where the product sells, each listing fixable from here: unlink it,
// move it to the product it really sells, or delete one that's gone.
export function ListingsCard({ d }: { d: ProductDetail }) {
	return (
		<Card
			title="Sales channels"
			flush={d.listings.length + d.aliases.length > 0}
		>
			{d.listings.length === 0 && d.aliases.length === 0 ? (
				<p className="text-muted-foreground">No listings.</p>
			) : (
				<ul className="pb-2">
					{d.listings.map((l) => (
						<li
							key={l.id}
							className="flex items-center gap-2 border-t px-4 py-2 first:border-t-0"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span>{channelName(l.channel)}</span>
									{l.fulfillment === "fba" && (
										<Badge>Fulfilled by Amazon</Badge>
									)}
									{l.goneAt && (
										<Tip content="No longer on the channel">
											<span>
												<Badge tone="warning">Gone</Badge>
											</span>
										</Tip>
									)}
								</div>
								<div className="truncate text-xs text-muted-foreground">
									{l.externalSku ? `${l.externalSku} · ` : ""}
									{l.title}
								</div>
							</div>
							<ListingMenu p={d.product} aliases={d.aliases} l={l} />
						</li>
					))}
					{d.aliases.length > 0 && (
						<li className="px-4 py-2 text-muted-foreground">
							Also sold as {d.aliases.join(", ")}
						</li>
					)}
				</ul>
			)}
		</Card>
	);
}

function ListingMenu({
	p,
	aliases,
	l,
}: {
	p: Product;
	aliases: string[];
	l: Listing;
}) {
	const [open, setOpen] = useState(false);
	const [relinking, setRelinking] = useState(false);
	const stays = rematches(p, aliases, l);
	const deletable = l.goneAt !== null && !l.sold;
	const close = () => {
		setOpen(false);
		setRelinking(false);
	};
	return (
		<Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
			<PopoverTrigger
				aria-label={`Fix ${l.title}`}
				className="rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
			>
				<MoreHorizontal className="size-4" />
			</PopoverTrigger>
			<PopoverContent className={relinking ? "w-96 p-0" : "w-56"}>
				{relinking ? (
					<ProductSearch
						autoFocus
						placeholder="Sells which product? SKU or name"
						refuse={(x) =>
							x.id === p.id
								? "This product"
								: x.kind === "bundle" && l.fulfillment === "fba"
									? "FBA can't sell a tool set"
									: null
						}
						onPick={(x) => {
							close();
							void relink(p, l, x.sku);
						}}
						onEscape={() => setRelinking(false)}
					/>
				) : (
					<ul>
						<MenuItem onSelect={() => setRelinking(true)}>
							<ArrowRightLeft />
							Relink to another product
						</MenuItem>
						<MenuItem
							disabled={
								stays &&
								"Its SKU matches this product, so it comes back. Relink it instead."
							}
							onSelect={() => {
								close();
								void unlink(p, l);
							}}
						>
							<Unlink />
							Unlink
						</MenuItem>
						{deletable && (
							<MenuItem
								critical
								onSelect={() => {
									close();
									void remove(p, l);
								}}
							>
								<Trash2 />
								Delete
							</MenuItem>
						)}
					</ul>
				)}
			</PopoverContent>
		</Popover>
	);
}

function MenuItem({
	onSelect,
	disabled = false,
	critical = false,
	children,
}: {
	onSelect: () => void;
	// Why it can't be picked, shown on hover.
	disabled?: string | false;
	critical?: boolean;
	children: ReactNode;
}) {
	const item = (
		<button
			type="button"
			disabled={disabled !== false}
			onClick={onSelect}
			className={cn(
				"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
				critical && "text-critical-text [&_svg]:text-critical-text",
			)}
		>
			{children}
		</button>
	);
	return (
		<li>
			{disabled ? (
				<Tip content={disabled}>
					<span className="block">{item}</span>
				</Tip>
			) : (
				item
			)}
		</li>
	);
}
