import NumberFlow from "@number-flow/react";
import { createFileRoute, Link, type LinkProps } from "@tanstack/react-router";
import { Badge, Banner, Card, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { FieldsCard, ListCard, ListSkeleton } from "#/components/skeleton";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import { statusSearch } from "#/products/views";
import { getDashboard } from "#/server/catalog";
import { countDiagnosticsAttention } from "#/server/diagnostics";
import { countOrdersToShip } from "#/server/orders";
import { getMonthProfit } from "#/server/profit";
import { countPosReady } from "#/server/purchasing";

export const Route = createFileRoute("/")({
	loader: async () => {
		const [dashboard, toShip, posReady, attention, monthProfit] =
			await Promise.all([
				getDashboard(),
				countOrdersToShip(),
				countPosReady(),
				countDiagnosticsAttention(),
				getMonthProfit(),
			]);
		return { ...dashboard, toShip, posReady, attention, monthProfit };
	},
	component: Home,
	pendingComponent: () => (
		<ListSkeleton title="Home">
			<FieldsCard lines={2} />
			<div className="grid gap-4 lg:grid-cols-2">
				<ListCard rows={5} picture />
				<ListCard rows={5} picture />
			</div>
		</ListSkeleton>
	),
});

function Home() {
	const d = Route.useLoaderData();

	return (
		<Page title="Home">
			<Card flush>
				<dl className="grid grid-cols-2 md:grid-cols-4 md:divide-x">
					<Stat label="Open orders" value={d.toShip} link={{ to: "/orders" }} />
					<Stat
						label="POs ready"
						value={d.posReady}
						link={{ to: "/purchasing" }}
					/>
					<Stat
						label="Oversold"
						value={d.oversold.length}
						tone={d.oversold.length > 0 ? "critical" : undefined}
						link={{
							to: "/products",
							search: statusSearch("oversold", [
								{ key: "inventory", desc: false },
							]),
						}}
					/>
					<Stat
						label="Profit this month"
						value={Math.round(d.monthProfit.profit)}
						money
						tone={d.monthProfit.profit < 0 ? "critical" : undefined}
						pending={
							d.monthProfit.unsure > 0
								? `${formatCount(d.monthProfit.unsure)} orders still waiting on a cost`
								: undefined
						}
						link={{ to: "/profit/overview" }}
					/>
				</dl>
			</Card>

			{d.attention > 0 && (
				<Banner
					tone="critical"
					title={`${formatCount(d.attention)} ${d.attention === 1 ? "problem" : "problems"} with order sync or tracking`}
					action={{ label: "Open Diagnostics", link: { to: "/diagnostics" } }}
				/>
			)}

			{d.blockedBundles > 0 && (
				<Banner
					tone="warning"
					title={`${formatCount(d.blockedBundles)} of ${formatCount(d.bundles)} tool sets can't be sold`}
					action={{
						label: "Review tool sets",
						link: { to: "/products", search: statusSearch("missing parts") },
					}}
				/>
			)}

			<div className="grid gap-4 lg:grid-cols-2">
				{d.atRisk.length > 0 && (
					<Card
						title={`${formatCount(d.atRisk.length)} A ${d.atRisk.length === 1 ? "item" : "items"} running out`}
						aside={
							<Link to="/purchasing" className="text-link hover:underline">
								Purchase orders
							</Link>
						}
						flush
					>
						<p className="px-4 pb-2 text-muted-foreground">
							Out before a new PO could arrive, even with what's on order.
						</p>
						<ul>
							{d.atRisk.slice(0, 6).map((r) => (
								<ProductRow key={r.sku} {...r}>
									<Badge tone={r.daysLeft === 0 ? "critical" : "warning"}>
										{r.daysLeft === 0
											? "Out now"
											: `${r.daysLeft} ${r.daysLeft === 1 ? "day" : "days"} left`}
									</Badge>
								</ProductRow>
							))}
						</ul>
					</Card>
				)}
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
								search={statusSearch("oversold", [
									{ key: "inventory", desc: false },
								])}
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
		</Page>
	);
}

// One stat in the strip. A stat whose source isn't connected says so plainly
// instead of showing a made-up zero.
function Stat({
	label,
	value,
	tone,
	link,
	pending,
	money = false,
}: {
	label: string;
	value?: number;
	money?: boolean;
	tone?: "critical";
	link?: LinkProps;
	pending?: string;
}) {
	const body = (
		<div className="flex h-full flex-col gap-1 p-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd
				className={cn(
					"text-xl font-bold tabular-nums",
					tone === "critical" && "text-critical-text",
				)}
			>
				{value === undefined ? (
					<span className="text-faint">—</span>
				) : (
					<NumberFlow
						value={value}
						format={
							money
								? {
										style: "currency",
										currency: "USD",
										maximumFractionDigits: 0,
									}
								: undefined
						}
					/>
				)}
			</dd>
			{pending && <dd className="text-xs text-muted-foreground">{pending}</dd>}
		</div>
	);
	return link ? (
		<Link {...link} className="block hover:bg-subtle">
			{body}
		</Link>
	) : (
		body
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
				className="flex items-center gap-3 px-4 py-2.5 hover:bg-subtle"
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
