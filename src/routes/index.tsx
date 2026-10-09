import NumberFlow from "@number-flow/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BarList } from "#/components/bar-list";
import { Badge, Banner, Card, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import {
	formatCount,
	formatMoneyCompact,
	formatMoneyWhole,
} from "#/lib/format";
import { getDashboard } from "#/server/catalog";

export const Route = createFileRoute("/")({
	loader: () => getDashboard(),
	component: Home,
});

function Home() {
	const d = Route.useLoaderData();
	const sellableSets = d.bundles - d.blockedBundles;

	return (
		<Page title="Home">
			{d.oversold.length > 0 && (
				<Banner
					tone="critical"
					title={`${formatCount(d.oversold.length)} products sold that we don't have`}
					action={{
						label: "Review oversold products",
						link: { to: "/products", search: { show: "oversold" } },
					}}
				>
					Count the shelf for each one, or a restock is overdue.
				</Banner>
			)}
			{d.blockedBundles > 0 && (
				<Banner
					tone="warning"
					title={`${formatCount(d.blockedBundles)} of ${formatCount(d.bundles)} tool sets can't be sold`}
					action={{
						label: "Review tool sets",
						link: { to: "/products", search: { show: "blocked" } },
					}}
				>
					Each is missing a part. The parts blocking the most sets are listed
					below.
				</Banner>
			)}

			<Card flush>
				<dl className="grid grid-cols-2 md:grid-cols-4 md:divide-x">
					<Metric label="Stock value" value={d.value} money />
					<Metric label="Units on hand" value={d.units} />
					<Metric label="Products oversold" value={d.oversold.length} />
					<Metric
						label="Tool sets ready to sell"
						value={sellableSets}
						suffix={` of ${formatCount(d.bundles)}`}
					/>
				</dl>
			</Card>

			<div className="grid gap-4 lg:grid-cols-2">
				{d.blockers.length > 0 && (
					<Card title="Missing parts holding up tool sets" flush>
						<ul>
							{d.blockers.map((b) => (
								<ProductRow key={b.sku} {...b}>
									<Badge tone="warning">
										Blocks {b.blocks} {b.blocks === 1 ? "set" : "sets"}
									</Badge>
								</ProductRow>
							))}
						</ul>
					</Card>
				)}
				{d.oversold.length > 0 && (
					<Card
						title="Oversold the most"
						aside={
							<Link
								to="/products"
								search={{ show: "oversold" }}
								className="text-link hover:underline"
							>
								View all {d.oversold.length}
							</Link>
						}
						flush
					>
						<ul>
							{d.oversold.slice(0, 6).map((o) => (
								<ProductRow key={o.sku} {...o}>
									<span className="font-semibold text-critical-text tabular-nums">
										{formatCount(o.onHand)}
									</span>
								</ProductRow>
							))}
						</ul>
					</Card>
				)}
			</div>

			<Card
				title="Stock value by product type"
				aside={
					d.uncosted > 0
						? `${formatCount(d.uncosted)} stocked products have no cost, so totals run low`
						: undefined
				}
			>
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
					<p className="px-2 pt-2 text-muted-foreground">
						Plus {formatMoneyCompact(d.otherCategories.value)} across{" "}
						{formatCount(d.otherCategories.count)} smaller types.
					</p>
				)}
			</Card>
		</Page>
	);
}

function Metric({
	label,
	value,
	money = false,
	suffix,
}: {
	label: string;
	value: number;
	money?: boolean;
	suffix?: string;
}) {
	return (
		<div className="flex flex-col gap-1 p-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="text-xl font-bold tabular-nums">
				<NumberFlow
					value={value}
					format={
						money
							? { style: "currency", currency: "USD", maximumFractionDigits: 0 }
							: undefined
					}
				/>
				{suffix && (
					<span className="text-sm font-normal text-muted-foreground">
						{suffix}
					</span>
				)}
			</dd>
		</div>
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
		<li className="border-t first:border-t-0">
			<Link
				to="/products/$sku"
				params={{ sku }}
				className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#f7f7f7]"
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
