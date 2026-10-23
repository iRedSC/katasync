import NumberFlow from "@number-flow/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { CountDialog } from "#/components/count-dialog";
import {
	AbcBadge,
	Badge,
	Card,
	Page,
	type Tone,
	useBack,
} from "#/components/page";
import { MovementTable, ProductImage, SetsChip } from "#/components/product";
import {
	ArchiveButton,
	ArchivedBadge,
	DeleteButton,
	RestoreButton,
} from "#/components/product-page/archived";
import {
	DetailsCard,
	NameField,
	VariantField,
} from "#/components/product-page/details-card";
import { ListingsCard } from "#/components/product-page/listings-card";
import { limits, PartsCard } from "#/components/product-page/parts-card";
import { StockTable } from "#/components/product-page/stock-table";
import { DetailSkeleton, FieldsCard, ListCard } from "#/components/skeleton";
import { StockRangeForm } from "#/components/stock-range-form";
import { SupplierCard } from "#/components/supplier-card";
import { TransferDialog } from "#/components/transfer-dialog";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import type { StockRange } from "#/inventory/stock-range";
import { formatCount } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimistic } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import {
	getDefaultRange,
	getProductDetail,
	type ProductDetail,
	saveProductStockRange,
} from "#/server/catalog";
import { getProductId } from "#/server/catalog/product-detail";
import { getProductSupplier } from "#/server/purchasing";

export const Route = createFileRoute("/products/$sku")({
	loader: async ({ params }) => {
		const productId = await getProductId({ data: { sku: params.sku } });
		const [detail, supplier, defaultRange] = await Promise.all([
			getProductDetail({ data: { productId } }),
			getProductSupplier({ data: { productId } }),
			getDefaultRange({ data: { productId } }),
		]);
		return { ...detail, supplier, defaultRange };
	},
	component: ProductPage,
	pendingComponent: () => (
		<DetailSkeleton
			back={{ to: "/products" }}
			main={
				<>
					<FieldsCard lines={4} />
					<ListCard title="Inventory" rows={2} />
				</>
			}
			side={
				<>
					<FieldsCard title="Availability" />
					<FieldsCard title="Sales channels" />
				</>
			}
		/>
	),
});

type ProductSupplier = Awaited<ReturnType<typeof getProductSupplier>>;
// What the page loads: the product, its supplier, and its default range.
type Loaded = ProductDetail & {
	supplier: ProductSupplier;
	defaultRange: StockRange;
};

// The page's data with changes the server hasn't confirmed laid over it.
const productData = optimistic<Loaded>("product");

// The shelf holds `onHand` at `location`, and what that makes sellable, as
// getAvailability works it out: our shelves (warehouse and retail store),
// never below zero.
function withShelf(d: Loaded, location: string, onHand: number): Loaded {
	const kind = d.locations.find((l) => l.name === location)?.kind ?? "owned";
	const stock = d.stock.some((s) => s.location === location)
		? d.stock.map((s) => (s.location === location ? { ...s, onHand } : s))
		: [...d.stock, { location, kind, onHand }];
	// The same rule as getAvailability: the warehouse, then what the retail
	// store holds above what it keeps.
	const { keep } = d.online;
	const kept = d.locations.find((l) => l.id === keep?.locationId)?.name;
	const selling = stock.filter((s) =>
		d.locations.some(
			(l) => l.name === s.location && d.online.locationIds.includes(l.id),
		),
	);
	const main = selling
		.filter((s) => s.location !== kept)
		.reduce((n, s) => n + s.onHand, 0);
	const spare = selling
		.filter((s) => s.location === kept)
		.reduce((n, s) => n + Math.max(0, s.onHand - (keep?.units ?? 0)), 0);
	return { ...d, stock, available: Math.max(0, main) + spare };
}

// A count sets its shelf to what was counted, as recording it does.
const countPatch = (productId: number, location: string, onHand: number) =>
	productData.patch(productId, (d) => {
		const next = withShelf(d, location, onHand);
		// The count ends not counted, as recording it does.
		return { ...next, product: { ...next.product, notCountedSince: null } };
	});

// A move takes `quantity` off one shelf and puts it on the other.
const movePatch = (
	productId: number,
	from: string,
	to: string,
	quantity: number,
) =>
	productData.patch(productId, (d) => {
		const had = (name: string) =>
			d.stock.find((s) => s.location === name)?.onHand ?? 0;
		const left = withShelf(d, from, had(from) - quantity);
		return withShelf(left, to, had(to) + quantity);
	});

const rangePatch = (productId: number, range: StockRange | null) =>
	productData.patch(productId, (d) => ({
		...d,
		product: {
			...d.product,
			minStock: range?.min ?? null,
			maxStock: range?.max ?? null,
		},
	}));

// Building kits (positive) or taking them apart (negative) at a location:
// the kit's shelf there changes by that many, and each part's by what goes
// into them, as convertKits posts it.
const kitPatch = (
	productId: number,
	location: { id: number; name: string },
	kits: number,
) =>
	productData.patch(productId, (d) => {
		const had = d.stock.find((s) => s.location === location.name)?.onHand ?? 0;
		const next = withShelf(d, location.name, had + kits);
		return {
			...next,
			components: next.components.map((c) => {
				const used = c.quantity * kits;
				const shelves = c.shelves.some((s) => s.locationId === location.id)
					? c.shelves.map((s) =>
							s.locationId === location.id
								? { ...s, onHand: s.onHand - used }
								: s,
						)
					: [...c.shelves, { locationId: location.id, onHand: -used }];
				return {
					...c,
					shelves,
					available: Math.max(0, c.available - used),
				};
			}),
		};
	});

function ProductPage() {
	const loaded = Route.useLoaderData();
	const d = productData.useData(loaded.product.id, loaded);
	const p = d.product;
	const goBack = useBack({ to: "/products" });
	const [counting, setCounting] = useState(false);
	const [moving, setMoving] = useState(false);
	const canCount = p.kind !== "bundle";
	const canMove = canCount && d.locations.length > 1;
	const verdict = getVerdict(d);

	useHotkeys({
		c: () => canCount && setCounting(true),
		m: () => canMove && setMoving(true),
		Escape: goBack,
	});

	return (
		<Page
			width="narrow"
			back={{ to: "/products" }}
			title={
				<span className="flex items-center gap-2">
					<span className="truncate">{p.name}</span>
					{p.kind === "bundle" && <Badge tone="info">Tool set</Badge>}
					{p.kind === "kit" && <Badge tone="info">Kit</Badge>}
					{p.archivedAt && <ArchivedBadge />}
				</span>
			}
			actions={
				<>
					{p.archivedAt && d.deletable && <DeleteButton sku={p.sku} />}
					{p.archivedAt ? (
						<RestoreButton productId={p.id} sku={p.sku} />
					) : (
						<ArchiveButton productId={p.id} sku={p.sku} />
					)}
					{canCount && (
						<Button onClick={() => setCounting(true)}>
							Count shelf
							<kbd className="text-xs opacity-60">C</kbd>
						</Button>
					)}
				</>
			}
		>
			<div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<div className="flex min-w-0 flex-col gap-4">
					<Card>
						<div className="flex items-center gap-4">
							<ProductImage src={p.imageUrl} className="size-24" />
							<div className="min-w-0">
								<p className="flex items-center gap-2 text-base font-semibold">
									<span className="min-w-0">
										<NameField p={p} />
									</span>
									{verdict && (
										<Tip content={verdict.detail}>
											<span className="inline-flex cursor-help">
												<Badge tone={verdict.tone}>{verdict.label}</Badge>
											</span>
										</Tip>
									)}
								</p>
								<VariantField p={p} />
								<p className="flex items-center gap-2 text-muted-foreground">
									{p.sku}
									<SetsChip sets={d.sets} />
								</p>
								{d.abc && (
									<p className="mt-1 flex items-center gap-2 text-muted-foreground">
										<AbcBadge abc={d.abc.abc} />
										<span>
											{formatShare(d.abc.share)} of{" "}
											{d.abc.days >= 365 ? "yearly" : `${d.abc.days}-day`}{" "}
											margin · #{formatCount(d.abc.rank)} of{" "}
											{formatCount(d.abc.of)}
										</span>
									</p>
								)}
							</div>
						</div>
					</Card>

					{p.kind !== "simple" && (
						<PartsCard
							d={d}
							kitPatch={(location, kits) => kitPatch(p.id, location, kits)}
						/>
					)}

					{canCount && (
						<Card
							title="Inventory"
							aside={
								<span className="flex gap-4">
									{canMove && (
										<button
											type="button"
											onClick={() => setMoving(true)}
											className="text-link hover:underline"
										>
											Move stock
										</button>
									)}
									<button
										type="button"
										onClick={() => setCounting(true)}
										className="text-link hover:underline"
									>
										Count shelf
									</button>
								</span>
							}
							flush
						>
							<StockTable
								productId={p.id}
								stock={d.stock}
								locations={d.locations}
								targets={d.targets}
							/>
							<div className="border-t px-4 py-3">
								<StockRangeForm
									value={
										p.minStock !== null && p.maxStock !== null
											? { min: p.minStock, max: p.maxStock }
											: null
									}
									defaults={d.defaultRange}
									onSave={(range) =>
										saveProductStockRange({ data: { productId: p.id, range } })
									}
									patch={(range) => ({
										label: `Stock range of ${p.sku}`,
										patch: rangePatch(p.id, range),
									})}
								/>
							</div>
						</Card>
					)}

					{canCount && (
						<Card title="History" flush>
							<MovementTable rows={d.history.slice(0, 10)} />
						</Card>
					)}
				</div>

				<div className="flex min-w-0 flex-col gap-4">
					<Card title="Availability">
						<div className="text-3xl font-bold tabular-nums">
							<NumberFlow value={d.available} />
						</div>
						<p className="text-muted-foreground">
							{p.kind === "bundle" ? "sets can be sold" : "can be sold"}
						</p>
					</Card>

					<DetailsCard d={d} />

					{canCount && (
						<SupplierCard
							productId={p.id}
							sku={p.sku}
							data={d.supplier}
							patch={(offers) => ({
								label: `Suppliers of ${p.sku}`,
								patch: productData.patch(p.id, (data) => ({
									...data,
									supplier: { ...data.supplier, offers },
								})),
							})}
						/>
					)}

					{d.group && d.variants.length > 1 && (
						<Card title="Variants">
							<div className="flex flex-wrap gap-1.5">
								{d.variants.map((v) => (
									<Link
										key={v.sku}
										to="/products/$sku"
										params={{ sku: v.sku }}
										className={cn(
											"rounded-lg px-2 py-0.5 font-medium",
											v.sku === p.sku
												? "bg-primary text-primary-foreground"
												: "bg-surface hover:bg-surface-strong",
										)}
									>
										{v.variantName ?? v.sku}
									</Link>
								))}
							</div>
						</Card>
					)}

					{d.usedIn.length > 0 && (
						<Card
							title={`Part of ${d.usedIn.length} tool ${d.usedIn.length === 1 ? "set" : "sets"}`}
							flush
						>
							<ul>
								{d.usedIn.map((u) => (
									<li key={u.sku} className="border-t first:border-t-0">
										<Link
											to="/products/$sku"
											params={{ sku: u.sku }}
											className="flex gap-2 px-4 py-2 hover:bg-subtle"
										>
											<span className="truncate">{u.name}</span>
											{u.quantity > 1 && (
												<span className="shrink-0 text-muted-foreground">
													× {u.quantity}
												</span>
											)}
										</Link>
									</li>
								))}
							</ul>
						</Card>
					)}

					<ListingsCard d={d} />
				</div>
			</div>

			{canCount && (
				<CountDialog
					open={counting}
					onOpenChange={setCounting}
					sku={p.sku}
					name={p.variantName ? `${p.name}, ${p.variantName}` : p.name}
					locations={d.locations}
					onHandByLocation={new Map(d.stock.map((s) => [s.location, s.onHand]))}
					patch={({ location, counted, previous }) => ({
						patch: countPatch(p.id, location, counted),
						undo: countPatch(p.id, location, previous),
					})}
				/>
			)}
			{canMove && (
				<TransferDialog
					open={moving}
					onOpenChange={setMoving}
					sku={p.sku}
					name={p.variantName ? `${p.name}, ${p.variantName}` : p.name}
					locations={d.locations}
					onHandByLocation={new Map(d.stock.map((s) => [s.location, s.onHand]))}
					patch={({ from, to, quantity }) => ({
						patch: movePatch(p.id, from, to, quantity),
						undo: movePatch(p.id, to, from, quantity),
					})}
				/>
			)}
		</Page>
	);
}

// A short label beside the name, worked out from the numbers, with the
// sentence a person can act on in its tooltip.
function getVerdict(
	d: ProductDetail,
): { tone: Tone; label: string; detail: ReactNode } | null {
	if (d.product.kind !== "bundle" && d.product.notCountedSince)
		return {
			tone: "info",
			label: "Not counted",
			detail:
				"Sells without limit on every channel until its first count. Sales still come off its number.",
		};
	if (d.product.kind === "bundle") {
		// A part that isn't counted yet sells without limit, so it's never short.
		const missing = d.components.filter(
			(c) => !c.notCounted && c.available < c.quantity,
		);
		if (missing.length > 0) {
			return {
				tone: "warning",
				label: "Can't sell",
				detail: (
					<>
						Not enough{" "}
						{missing.map((c, i) => (
							<span key={c.sku}>
								{i > 0 && (i === missing.length - 1 ? " or " : ", ")}
								{c.name}
								{c.quantity > 1 &&
									` (needs ${c.quantity}, have ${formatCount(c.available)})`}
							</span>
						))}
						.
					</>
				),
			};
		}
		// Its count leaves out parts without limit, so it isn't worth warning on.
		if (d.available > 3 || d.components.some((c) => c.notCounted)) return null;
		const limiting = d.components.filter((c) => limits(d, c));
		return {
			tone: "warning",
			label: `Only ${formatCount(d.available)} left`,
			detail:
				limiting.length === 1
					? `${limiting[0].name} runs out first.`
					: `${limiting.length === d.components.length ? "Every part runs" : `${limiting.length} parts run`} out at the same time.`,
		};
	}
	// Amazon's FBA stock can't cover our shelf.
	const onHand = d.stock
		.filter((s) => s.kind !== "fba")
		.reduce((sum, s) => sum + s.onHand, 0);
	if (onHand < 0) {
		return {
			tone: "critical",
			label: `Oversold by ${formatCount(-onHand)}`,
			detail: "Count the shelf.",
		};
	}
	return null;
}

// Small shares keep a decimal so they don't all read as 0%.
function formatShare(share: number) {
	const pct = share * 100;
	return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}
