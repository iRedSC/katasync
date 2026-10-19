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
import {
	MovementTable,
	ProductImage,
	ProductName,
	SetsChip,
} from "#/components/product";
import {
	AerosolToggle,
	CriticalToggle,
	InsureToggle,
} from "#/components/product-page/flag-toggles";
import { DetailSkeleton, FieldsCard, ListCard } from "#/components/skeleton";
import { StockRangeForm } from "#/components/stock-range-form";
import { SupplierCard } from "#/components/supplier-card";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import type { StockRange } from "#/inventory/stock-range";
import { channelName, formatCount, formatMoney } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimistic } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import {
	getDefaultRange,
	getProductDetail,
	type ProductDetail,
	saveProductStockRange,
} from "#/server/catalog";
import { getProductSupplier } from "#/server/purchasing";

export const Route = createFileRoute("/products/$sku")({
	loader: async ({ params }) => {
		const detail = await getProductDetail({ data: { sku: params.sku } });
		const [supplier, defaultRange] = await Promise.all([
			getProductSupplier({ data: { productId: detail.product.id } }),
			getDefaultRange({ data: { productId: detail.product.id } }),
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
// getAvailability works it out: owned stock only, never below zero.
function withShelf(d: Loaded, location: string, onHand: number): Loaded {
	const stock = d.stock.some((s) => s.location === location)
		? d.stock.map((s) => (s.location === location ? { ...s, onHand } : s))
		: [...d.stock, { location, kind: "owned" as const, onHand }];
	const available = stock.reduce(
		(n, s) => (s.kind === "owned" ? n + s.onHand : n),
		0,
	);
	return { ...d, stock, available: Math.max(0, available) };
}

// A count sets its shelf to what was counted, as recording it does.
const countPatch = (productId: number, location: string, onHand: number) =>
	productData.patch(productId, (d) => withShelf(d, location, onHand));

const rangePatch = (productId: number, range: StockRange | null) =>
	productData.patch(productId, (d) => ({
		...d,
		product: {
			...d.product,
			minStock: range?.min ?? null,
			maxStock: range?.max ?? null,
		},
	}));

function ProductPage() {
	const loaded = Route.useLoaderData();
	const d = productData.useData(loaded.product.id, loaded);
	const p = d.product;
	const goBack = useBack({ to: "/products" });
	const [counting, setCounting] = useState(false);
	const canCount = p.kind !== "bundle";
	const verdict = getVerdict(d);

	useHotkeys({
		c: () => canCount && setCounting(true),
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
				</span>
			}
			actions={
				canCount && (
					<Button onClick={() => setCounting(true)}>
						Count shelf
						<kbd className="text-xs opacity-60">C</kbd>
					</Button>
				)
			}
		>
			<div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<div className="flex min-w-0 flex-col gap-4">
					<Card>
						<div className="flex items-center gap-4">
							<ProductImage src={p.imageUrl} className="size-24" />
							<div className="min-w-0">
								<p className="flex items-center gap-2 text-base font-semibold">
									<span className="min-w-0">{p.name}</span>
									{verdict && (
										<Tip content={verdict.detail}>
											<span className="inline-flex cursor-help">
												<Badge tone={verdict.tone}>{verdict.label}</Badge>
											</span>
										</Tip>
									)}
								</p>
								{p.variantName && (
									<p className="text-muted-foreground">{p.variantName}</p>
								)}
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

					{d.components.length > 0 && (
						<Card
							title={p.kind === "bundle" ? "Parts in this set" : "Built from"}
							flush
						>
							<table className="w-full">
								<thead>
									<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
										<th className="px-4 py-2 font-medium">Part</th>
										<th className="px-4 py-2 text-right font-medium">Needed</th>
										<th className="px-4 py-2 text-right font-medium">
											In stock
										</th>
									</tr>
								</thead>
								<tbody>
									{d.components.map((c) => {
										const short = c.available < c.quantity;
										return (
											<tr key={c.sku} className="border-t first:border-t-0">
												<td className="px-4 py-2.5">
													<Link
														to="/products/$sku"
														params={{ sku: c.sku }}
														className="block hover:underline"
													>
														<ProductName
															name={c.name}
															variantName={c.variantName}
														/>
													</Link>
													<div className="text-xs text-muted-foreground">
														{c.sku}
													</div>
												</td>
												<td className="px-4 py-2.5 text-right tabular-nums">
													{c.quantity}
												</td>
												<td className="px-4 py-2.5 text-right">
													{short ? (
														<Badge tone="warning">
															Only {formatCount(c.available)}
														</Badge>
													) : limits(d, c) ? (
														<Tip content="Runs out first">
															<span className="font-semibold text-warning-text tabular-nums">
																{formatCount(c.available)}
															</span>
														</Tip>
													) : (
														<span className="tabular-nums">
															{formatCount(c.available)}
														</span>
													)}
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</Card>
					)}

					{canCount && (
						<Card
							title="Inventory"
							aside={
								<button
									type="button"
									onClick={() => setCounting(true)}
									className="text-link hover:underline"
								>
									Count shelf
								</button>
							}
							flush
						>
							<table className="w-full">
								<thead>
									<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
										<th className="px-4 py-2 font-medium">Location</th>
										<th className="px-4 py-2 text-right font-medium">
											On hand
										</th>
									</tr>
								</thead>
								<tbody>
									{d.stock.length === 0 && (
										<tr>
											<td
												className="px-4 py-2.5 text-muted-foreground"
												colSpan={2}
											>
												No stock recorded.
											</td>
										</tr>
									)}
									{d.stock.map((s) => (
										<tr key={s.location} className="border-t first:border-t-0">
											<td className="px-4 py-2.5">
												{s.location}
												{s.kind === "fba" && (
													<span className="ml-2">
														<Badge>Amazon's, not ours to ship</Badge>
													</span>
												)}
											</td>
											<td
												className={cn(
													"px-4 py-2.5 text-right font-semibold tabular-nums",
													s.onHand < 0 && "text-critical-text",
												)}
											>
												<NumberFlow value={s.onHand} />
											</td>
										</tr>
									))}
								</tbody>
							</table>
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

					<Details d={d} />

					{canCount && (
						<SupplierCard
							productId={p.id}
							data={d.supplier}
							patch={(link) => ({
								label: `Supplier of ${p.sku}`,
								patch: productData.patch(p.id, (data) => ({
									...data,
									supplier: { ...data.supplier, link },
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

					<Card title="Sales channels">
						{d.listings.length === 0 && d.aliases.length === 0 ? (
							<p className="text-muted-foreground">No listings.</p>
						) : (
							<ul className="flex flex-col gap-1.5">
								{d.listings.map((l) => (
									<li
										key={`${l.store}-${l.externalId}`}
										className="flex justify-between gap-2"
									>
										<span>{channelName(l.channel)}</span>
										{l.fulfillment === "fba" && (
											<Badge>Fulfilled by Amazon</Badge>
										)}
									</li>
								))}
								{d.aliases.length > 0 && (
									<li className="text-muted-foreground">
										Also sold as {d.aliases.join(", ")}
									</li>
								)}
							</ul>
						)}
					</Card>
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
		</Page>
	);
}

// A short label beside the name, worked out from the numbers, with the
// sentence a person can act on in its tooltip.
function getVerdict(
	d: ProductDetail,
): { tone: Tone; label: string; detail: ReactNode } | null {
	if (d.product.kind === "bundle") {
		const missing = d.components.filter((c) => c.available < c.quantity);
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
		if (d.available > 3) return null;
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
		.filter((s) => s.kind === "owned")
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

// Whether a part is what caps how many of the set can be sold, once few are
// left.
function limits(d: ProductDetail, c: ProductDetail["components"][number]) {
	return (
		d.product.kind === "bundle" &&
		d.available <= 3 &&
		c.available >= c.quantity &&
		Math.floor(c.available / c.quantity) === d.available
	);
}

// Only what's filled in. Empty fields aren't worth a glance.
function Details({ d }: { d: ProductDetail }) {
	const p = d.product;
	const rows: [string, ReactNode][] = [];
	// Type, vendor, and tags come from Shopify when we don't have our own.
	const type = p.category ?? d.listings.find((l) => l.productType)?.productType;
	const vendor = d.listings.find((l) => l.vendor)?.vendor;
	const tags = [...new Set(d.listings.flatMap((l) => l.tags))].sort();
	if (type) rows.push(["Type", type]);
	if (vendor) rows.push(["Vendor", vendor]);
	if (tags.length > 0) rows.push(["Tags", tags.join(", ")]);
	if (p.unitCost !== null) rows.push(["Cost", formatMoney(p.unitCost)]);
	if (p.barcode) rows.push(["Barcode", p.barcode]);
	if (p.weightGrams) rows.push(["Weight", `${formatCount(p.weightGrams)} g`]);
	if (p.lengthMm && p.widthMm && p.heightMm) {
		rows.push(["Box", `${p.lengthMm} × ${p.widthMm} × ${p.heightMm} mm`]);
	}
	return (
		<Card title="Product organization">
			{rows.length > 0 && (
				<dl className="mb-3 flex flex-col gap-2">
					{rows.map(([label, value]) => (
						<div key={label}>
							<dt className="text-muted-foreground">{label}</dt>
							<dd className="tabular-nums">{value}</dd>
						</div>
					))}
				</dl>
			)}
			<div className="flex flex-col gap-2">
				<InsureToggle
					productId={p.id}
					sku={p.sku}
					insure={p.insureWhenShipped}
				/>
				<AerosolToggle productId={p.id} sku={p.sku} aerosol={p.aerosol} />
				<CriticalToggle
					productId={p.id}
					sku={p.sku}
					critical={p.critical}
					isA={d.abc?.abc === "A"}
				/>
			</div>
		</Card>
	);
}

// Small shares keep a decimal so they don't all read as 0%.
function formatShare(share: number) {
	const pct = share * 100;
	return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}
