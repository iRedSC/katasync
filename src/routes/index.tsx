import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, Link2, Truck } from "lucide-react";
import { EmptyState, PageBody, PageHeader } from "#/components/page";
import { Badge } from "#/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { formatCount, formatMoney } from "#/lib/format";
import { getDashboard } from "#/server/catalog";

export const Route = createFileRoute("/")({
	loader: () => getDashboard(),
	component: Dashboard,
});

function Dashboard() {
	const data = Route.useLoaderData();
	return (
		<>
			<PageHeader title="Dashboard" />
			<PageBody>
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
					<Stat
						label="Products"
						value={formatCount(data.products)}
						hint={`${formatCount(data.bundles)} bundles`}
					/>
					<Stat
						label="Units on hand"
						value={formatCount(data.units)}
						hint="Across owned locations"
					/>
					<Stat
						label="Stock value"
						value={formatMoney(data.value)}
						hint="At landed cost, where known"
					/>
					<Stat
						label="Bundles out of stock"
						value={formatCount(data.bundlesOut)}
						hint={`of ${formatCount(data.bundles)}`}
					/>
				</div>

				<div className="grid gap-4 lg:grid-cols-2">
					<Card>
						<CardHeader>
							<CardTitle>To ship</CardTitle>
							<CardDescription>
								Open orders across every channel
							</CardDescription>
						</CardHeader>
						<CardContent>
							<EmptyState icon={Truck} title="Order intake isn't connected yet">
								Orders from Shopify, Amazon, eBay, and TikTok Shop will queue
								here.
							</EmptyState>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>Unmapped listings</CardTitle>
							<CardDescription>
								Channel listings not yet tied to a product
							</CardDescription>
						</CardHeader>
						<CardContent>
							<EmptyState
								icon={Link2}
								title={
									data.unmappedListings === 0
										? "Nothing to map"
										: `${data.unmappedListings} to map`
								}
							>
								Listings arrive once channels sync.{" "}
								<Link to="/listings" className="text-primary underline">
									Open listings
								</Link>
							</EmptyState>
						</CardContent>
					</Card>
				</div>

				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<AlertTriangle className="size-4 text-destructive" />
							Oversold
							<Badge variant="secondary">{data.oversold.length}</Badge>
						</CardTitle>
						<CardDescription>
							Products with negative stock: sold before we had them
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>SKU</TableHead>
									<TableHead>Product</TableHead>
									<TableHead className="text-right">On hand</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.oversold.slice(0, 15).map((row) => (
									<TableRow key={row.sku}>
										<TableCell className="font-mono text-xs">
											<Link
												to="/products/$sku"
												params={{ sku: row.sku }}
												className="hover:underline"
											>
												{row.sku}
											</Link>
										</TableCell>
										<TableCell>
											{row.name}
											{row.variantName && (
												<span className="text-muted-foreground">
													{" "}
													· {row.variantName}
												</span>
											)}
										</TableCell>
										<TableCell className="text-right font-medium text-destructive tabular-nums">
											{formatCount(row.onHand)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						{data.oversold.length > 15 && (
							<p className="pt-3 text-sm text-muted-foreground">
								And {data.oversold.length - 15} more.
							</p>
						)}
					</CardContent>
				</Card>
			</PageBody>
		</>
	);
}

function Stat({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
	hint: string;
}) {
	return (
		<Card>
			<CardHeader>
				<CardDescription>{label}</CardDescription>
				<CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
			</CardHeader>
			<CardContent className="text-xs text-muted-foreground">
				{hint}
			</CardContent>
		</Card>
	);
}
