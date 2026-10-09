import { createFileRoute, Link } from "@tanstack/react-router";
import { BarList } from "#/components/bar-list";
import { PageBody, PageHeader, Section, StatusTile } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import {
	formatCount,
	formatMoneyCompact,
	formatMoneyWhole,
} from "#/lib/format";
import { getDashboard } from "#/server/catalog";

export const Route = createFileRoute("/")({
	loader: () => getDashboard(),
	component: Today,
});

function Today() {
	const d = Route.useLoaderData();
	const allGood = d.oversold.length === 0 && d.blockedBundles === 0;

	return (
		<>
			<PageHeader title="Today" />
			<PageBody>
				<div className="grid gap-4 md:grid-cols-2">
					{d.oversold.length > 0 && (
						<StatusTile
							tone="bad"
							value={d.oversold.length}
							label="products sold that we don't have"
							hint="Count the shelf, or a restock is overdue"
							link={{ to: "/products", search: { show: "oversold" } }}
						/>
					)}
					{d.blockedBundles > 0 && (
						<StatusTile
							tone="warn"
							value={d.blockedBundles}
							label={`of ${formatCount(d.bundles)} tool sets can't be sold`}
							hint="A part is missing. The ones blocking the most are below."
							link={{ to: "/products", search: { show: "blocked" } }}
						/>
					)}
					{allGood && (
						<StatusTile
							tone="good"
							value={0}
							label="problems. Everything can be sold."
						/>
					)}
				</div>

				<div className="grid gap-10 lg:grid-cols-2">
					{d.blockers.length > 0 && (
						<Section title="Missing parts holding up tool sets">
							<ul className="flex flex-col">
								{d.blockers.map((b) => (
									<ProductRow
										key={b.sku}
										sku={b.sku}
										name={b.name}
										variantName={b.variantName}
										imageUrl={b.imageUrl}
									>
										<span className="text-sm text-muted-foreground">
											blocks{" "}
											<span className="text-base font-semibold text-foreground tabular-nums">
												{b.blocks}
											</span>{" "}
											{b.blocks === 1 ? "set" : "sets"}
										</span>
									</ProductRow>
								))}
							</ul>
						</Section>
					)}

					{d.oversold.length > 0 && (
						<Section
							title="Sold the most beyond what we have"
							aside={
								<Link
									to="/products"
									search={{ show: "oversold" }}
									className="inline-flex items-center gap-1 hover:text-foreground"
								>
									See all {d.oversold.length}
								</Link>
							}
						>
							<ul className="flex flex-col">
								{d.oversold.slice(0, 6).map((o) => (
									<ProductRow key={o.sku} {...o}>
										<span className="text-base font-semibold text-bad-ink tabular-nums">
											{formatCount(o.onHand)}
										</span>
									</ProductRow>
								))}
							</ul>
						</Section>
					)}
				</div>

				<Section
					title="Where the money sits"
					aside={
						d.uncosted > 0
							? `${formatCount(d.uncosted)} stocked products have no cost yet, so this is low`
							: undefined
					}
				>
					<div className="flex flex-col gap-6 rounded-xl border p-6">
						<div>
							<div className="text-5xl font-semibold tracking-tight tabular-nums">
								{formatMoneyWhole(d.value)}
							</div>
							<div className="mt-1 text-muted-foreground">
								in stock across {formatCount(d.units)} units
							</div>
						</div>
						<BarList
							rows={d.byCategory.map((c) => ({
								label: c.category,
								value: c.value,
							}))}
							format={formatMoneyCompact}
							detail={(i) =>
								`${formatMoneyWhole(d.byCategory[i].value)} across ${formatCount(d.byCategory[i].units)} units`
							}
						/>
						{d.otherCategories.count > 0 && (
							<p className="px-2 text-sm text-muted-foreground">
								Plus {formatMoneyCompact(d.otherCategories.value)} spread across{" "}
								{formatCount(d.otherCategories.count)} smaller types.
							</p>
						)}
					</div>
				</Section>
			</PageBody>
		</>
	);
}

function ProductRow({
	sku,
	name,
	variantName,
	imageUrl,
	children,
}: {
	sku: string;
	name: string;
	variantName: string | null;
	imageUrl: string | null;
	children: React.ReactNode;
}) {
	return (
		<li>
			<Link
				to="/products/$sku"
				params={{ sku }}
				className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent"
			>
				<ProductImage src={imageUrl} className="size-9" />
				<div className="min-w-0 flex-1">
					<ProductName name={name} variantName={variantName} />
					<div className="text-xs text-muted-foreground">{sku}</div>
				</div>
				{children}
			</Link>
		</li>
	);
}
