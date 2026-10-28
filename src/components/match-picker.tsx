import { Command as CommandPrimitive } from "cmdk";
import { Loader2, Plus, RotateCw, Search } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChannelBadge } from "#/components/channel-badge";
import { matchDrafts, useMatchDraft } from "#/components/match-drafts";
import { Badge } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount } from "#/lib/format";
import { optimism, type Patch } from "#/lib/optimism";
import { type IndexedProduct, useProductIndex } from "#/lib/product-index";
import { productSearch } from "#/lib/product-search";
import {
	createListingProduct,
	listUnmatchedItems,
	matchListing,
} from "#/server/catalog";

export type UnmatchedItem = Awaited<
	ReturnType<typeof listUnmatchedItems>
>[number];
type Product = IndexedProduct;

const REASON = {
	"same-sku": "Same SKU",
	"matched-before": "Matched before",
	"part-number": "Part no.",
	"same-name": "Same name",
	"similar-name": null,
} as const;

const search = (products: Product[], query: string) =>
	productSearch(products, query, { limit: 30 });

// What one resolution does: match to a product, or make a new one.
export type Resolution =
	| { kind: "match"; sku: string }
	| { kind: "create"; sku: string; name: string };

// Sends a resolution through the optimism engine and says what it did. The
// patch takes the item off whatever screen asked.
export async function resolveItem(
	item: UnmatchedItem,
	r: Resolution,
	patch?: Patch,
) {
	const send = () =>
		r.kind === "match"
			? matchListing({ data: { listingIds: item.listingIds, sku: r.sku } })
			: createListingProduct({
					data: { listingIds: item.listingIds, sku: r.sku, name: r.name },
				});
	const label = `${r.kind === "match" ? "Matching" : "Creating"} ${item.title}`;
	const result = patch
		? await optimism.change({ label, patch, send })
		: await optimism.change({ send });
	if (!result) return false;
	const { sku, ordersUpdated, problems } = result.value;
	if (problems.length > 0)
		toast.warning(`${item.title} → ${sku}, stock not taken`, {
			description: problems.join(". "),
		});
	else
		toast.success(`${item.title} → ${sku}`, {
			description:
				ordersUpdated > 0
					? `${formatCount(ordersUpdated)} order ${ordersUpdated === 1 ? "line" : "lines"}`
					: undefined,
		});
	return true;
}

// An unmatched item, shaped like a product row.
export function ItemHeader({ item }: { item: UnmatchedItem }) {
	return (
		<div className="flex items-center gap-3">
			<ProductImage src={null} className="size-12" />
			<div className="min-w-0 flex-1">
				<div className="truncate text-base font-semibold">{item.title}</div>
				<div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
					<span>{item.sku ?? "No SKU"}</span>
					{item.channels.map((c) => (
						<ChannelBadge key={c} channel={c} salesChannel={null} compact />
					))}
				</div>
			</div>
			{item.units > 0 && (
				<Badge tone="critical">{formatCount(item.units)} sold</Badge>
			)}
		</div>
	);
}

function ProductRow({
	product,
	trailing,
}: {
	product: Pick<Product, "sku" | "name" | "variantName" | "imageUrl">;
	trailing?: ReactNode;
}) {
	return (
		<>
			<ProductImage src={product.imageUrl} className="size-9" />
			<div className="min-w-0 flex-1">
				<ProductName name={product.name} variantName={product.variantName} />
				<div className="text-xs text-muted-foreground">{product.sku}</div>
			</div>
			{trailing}
		</>
	);
}

const CREATE = "__create";

const itemKey = (item: UnmatchedItem) => item.listingIds.join();

const rowClass =
	"flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 data-[selected=true]:bg-surface";

// Decides one unmatched item: its likely products first, any product by
// typing, or a new product. The same picker on the queue, an order, or
// profit. `onResolve` says whether it went through; a new product that
// didn't save stays filled in for another try.
export function MatchPicker({
	item,
	onResolve,
	actions,
}: {
	item: UnmatchedItem;
	onResolve: (r: Resolution) => Promise<boolean>;
	// Extra buttons beside New, e.g. Skip on the queue.
	actions?: ReactNode;
}) {
	const index = useProductIndex();
	const [query, setQuery] = useState("");
	const key = itemKey(item);
	const draft = useMatchDraft(key);
	const [creating, setCreating] = useState(draft !== null);
	// The item being sent, so the next item isn't held up while it is.
	const [sending, setSending] = useState<string | null>(null);
	const sendingThis = sending === key;
	const q = query.trim();
	const results =
		q.length >= 2 && index.status === "ready"
			? search(index.products, q)
			: null;
	const rows = results?.map((p) => ({ ...p, reason: null })) ?? item.candidates;
	// The highlighted row: the best guess until arrows move it.
	const [highlight, setHighlight] = useState("");
	const first = rows[0]?.sku ?? CREATE;
	const input = useRef<HTMLInputElement>(null);

	// A different item starts fresh, ready to type.
	useEffect(() => {
		setQuery("");
		setCreating(matchDrafts.get(key) !== null);
		input.current?.focus();
	}, [key]);
	// An item back after failing to save returns to its filled-in form.
	useEffect(() => {
		if (draft) setCreating(true);
	}, [draft]);
	// New rows highlight their first.
	useEffect(() => setHighlight(first), [first]);

	async function resolve(r: Resolution) {
		if (sendingThis) return;
		setSending(key);
		const ok = await onResolve(r);
		setSending((s) => (s === key ? null : s));
		if (r.kind !== "create") return;
		matchDrafts.set(key, ok ? null : { sku: r.sku, name: r.name });
	}

	return (
		<div className="flex flex-col gap-4">
			<ItemHeader item={item} />
			{creating ? (
				<CreateForm
					key={key}
					item={item}
					initial={draft}
					sending={sendingThis}
					onCancel={() => {
						matchDrafts.set(key, null);
						setCreating(false);
					}}
					onCreate={(sku, name) => resolve({ kind: "create", sku, name })}
				/>
			) : (
				<CommandPrimitive
					shouldFilter={false}
					loop
					value={highlight}
					onValueChange={setHighlight}
					className="rounded-xl border"
				>
					<div className="flex items-center gap-2 border-b px-3">
						<Search className="size-4 shrink-0 text-muted-foreground" />
						<CommandPrimitive.Input
							ref={input}
							autoFocus
							value={query}
							onValueChange={setQuery}
							disabled={sendingThis}
							placeholder="SKU or name"
							className="h-10 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
						/>
					</div>
					<CommandPrimitive.List className="max-h-80 overflow-y-auto p-1">
						{results === null &&
							q.length >= 2 &&
							index.status === "loading" && (
								<p className="px-3 py-4 text-muted-foreground">Loading…</p>
							)}
						{results === null && q.length >= 2 && index.status === "failed" && (
							<div className="flex items-center gap-2 px-3 py-2 text-critical-text">
								<span className="min-w-0 flex-1 truncate">
									Couldn't load products: {index.message}
								</span>
								<Button variant="ghost" size="sm" onClick={index.retry}>
									<RotateCw />
									Retry
								</Button>
							</div>
						)}
						{rows.map((p) => {
							const reason = p.reason && REASON[p.reason];
							return (
								<CommandPrimitive.Item
									key={p.sku}
									value={p.sku}
									disabled={sendingThis}
									onSelect={() => resolve({ kind: "match", sku: p.sku })}
									className={rowClass}
								>
									<ProductRow
										product={p}
										trailing={reason && <Badge tone="success">{reason}</Badge>}
									/>
								</CommandPrimitive.Item>
							);
						})}
						{results?.length === 0 && (
							<p className="px-3 py-4 text-muted-foreground">No products</p>
						)}
						<CommandPrimitive.Item
							value={CREATE}
							disabled={sendingThis}
							onSelect={() => setCreating(true)}
							className={rowClass}
						>
							<div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground">
								<Plus className="size-4" />
							</div>
							<div className="font-medium">New product</div>
						</CommandPrimitive.Item>
					</CommandPrimitive.List>
				</CommandPrimitive>
			)}
			{actions && <div className="flex justify-end gap-2">{actions}</div>}
		</div>
	);
}

function CreateForm({
	item,
	initial,
	sending,
	onCreate,
	onCancel,
}: {
	item: UnmatchedItem;
	// What was typed last time, when it didn't save.
	initial: { sku: string; name: string } | null;
	sending: boolean;
	onCreate: (sku: string, name: string) => void;
	onCancel: () => void;
}) {
	const [sku, setSku] = useState(initial?.sku ?? item.sku ?? "");
	const [name, setName] = useState(initial?.name ?? item.title);
	const ready = sku.trim() !== "" && name.trim() !== "" && !sending;
	return (
		<form
			className="flex flex-col gap-3 rounded-xl border p-3"
			onSubmit={(e) => {
				e.preventDefault();
				if (ready) onCreate(sku.trim(), name.trim());
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					onCancel();
				}
			}}
		>
			<div className="flex items-center gap-3">
				<ProductImage src={null} className="size-9" />
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						aria-label="Name"
						className="h-8 rounded-md border bg-transparent px-2 font-medium outline-none focus:ring-2 focus:ring-ring"
					/>
					<input
						// biome-ignore lint/a11y/noAutofocus: the SKU is what's missing
						autoFocus
						value={sku}
						onChange={(e) => setSku(e.target.value)}
						placeholder="SKU"
						aria-label="SKU"
						className="h-7 w-48 rounded-md border bg-transparent px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
					/>
				</div>
			</div>
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Back
				</Button>
				<Button type="submit" size="sm" disabled={!ready}>
					{sending && <Loader2 className="animate-spin" />}
					Create
				</Button>
			</div>
		</form>
	);
}

// The picker over another page, for the unmatched items one order sold.
// Steps through them and closes after the last; the page reloads behind it.
export function MatchDialog({
	orderId,
	onClose,
}: {
	orderId: number | null;
	onClose: () => void;
}) {
	const [items, setItems] = useState<UnmatchedItem[] | null>(null);
	const [at, setAt] = useState(0);

	useEffect(() => {
		setItems(null);
		setAt(0);
		if (orderId === null) return;
		let current = true;
		listUnmatchedItems({ data: { orderId } }).then(
			(found) => current && setItems(found),
			(err) => {
				if (!current) return;
				toast.error(err instanceof Error ? err.message : String(err));
				onClose();
			},
		);
		return () => {
			current = false;
		};
	}, [orderId, onClose]);

	const item = items?.[at];
	// The item showing now. A fresh load per order makes fresh items, so one
	// sent before staff skipped on, or closed this order and opened another,
	// finds it gone when it's answered.
	const showing = useRef(item);
	showing.current = item;
	useEffect(() => {
		if (items && items.length === 0) {
			toast("Nothing left to match on this order");
			onClose();
		}
	}, [items, onClose]);

	const next = () =>
		items && at + 1 < items.length ? setAt(at + 1) : onClose();
	// Moves on only once it went through, so a failure keeps the item and
	// whatever was typed, and only if staff are still on it.
	async function resolve(item: UnmatchedItem, r: Resolution) {
		const ok = await resolveItem(item, r);
		if (ok && showing.current === item) next();
		return ok;
	}

	return (
		<Dialog open={orderId !== null} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-xl gap-0 p-5" showCloseButton={false}>
				<DialogTitle className="sr-only">Match</DialogTitle>
				<DialogDescription className="sr-only">
					Pick the product this listing sells
				</DialogDescription>
				{!item ? (
					<p className="py-8 text-center text-muted-foreground">Loading…</p>
				) : (
					<MatchPicker
						item={item}
						onResolve={(r) => resolve(item, r)}
						actions={
							items && items.length > 1 ? (
								<>
									<span className="mr-auto self-center text-xs text-muted-foreground tabular-nums">
										{at + 1} / {items.length}
									</span>
									<Button variant="ghost" size="sm" onClick={next}>
										Skip
									</Button>
								</>
							) : undefined
						}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
