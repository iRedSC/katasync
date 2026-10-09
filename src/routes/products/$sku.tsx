import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Link2 } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, PageBody, PageHeader } from "#/components/page";
import {
	KindBadge,
	MovementTable,
	ProductImage,
	ProductLink,
} from "#/components/product";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
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
import { getProductDetail } from "#/server/catalog";

export const Route = createFileRoute("/products/$sku")({
	loader: ({ params }) => getProductDetail({ data: { sku: params.sku } }),
	component: ProductPage,
});

function ProductPage() {
	const d = Route.useLoaderData();
	const p = d.product;
	const onHand = d.stock.reduce((sum, s) => sum + s.onHand, 0);

	return (
		<>
			<PageHeader
				title={p.variantName ? `${p.name} · ${p.variantName}` : p.name}
				description={p.sku}
				actions={
					<Button variant="outline" size="sm" asChild>
						<Link to="/products">
							<ArrowLeft />
							Products
						</Link>
					</Button>
				}
			/>
			<PageBody>
				<div className="flex flex-col gap-6 md:flex-row">
					<ProductImage src={p.imageUrl} className="size-40" />
					<div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-3 text-sm lg:grid-cols-4">
						<Field label="Kind">
							<KindBadge kind={p.kind} />
						</Field>
						<Field label="Available">
							<span className="text-xl font-semibold tabular-nums">
								{formatCount(d.available)}
							</span>
						</Field>
						<Field label="On hand">
							{p.kind === "bundle" ? "—" : formatCount(onHand)}
						</Field>
						<Field label="Unit cost">{formatMoney(p.unitCost)}</Field>
						<Field label="Category">{p.category ?? "—"}</Field>
						<Field label="Barcode">
							<span className="font-mono">{p.barcode ?? "—"}</span>
						</Field>
						<Field label="Weight">
							{p.weightGrams ? `${formatCount(p.weightGrams)} g` : "—"}
						</Field>
						<Field label="Box">
							{p.lengthMm && p.widthMm && p.heightMm
								? `${p.lengthMm} × ${p.widthMm} × ${p.heightMm} mm`
								: "—"}
						</Field>
					</div>
				</div>

				<div className="grid gap-4 lg:grid-cols-2">
					{d.components.length > 0 && (
						<Card>
							<CardHeader>
								<CardTitle>Components</CardTitle>
								<CardDescription>
									{p.kind === "bundle"
										? "Picked from these at pack time; availability is limited by the scarcest"
										: "Assembled from these"}
								</CardDescription>
							</CardHeader>
							<CardContent>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Product</TableHead>
											<TableHead className="text-right">Qty</TableHead>
											<TableHead className="text-right">Available</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{d.components.map((c) => (
											<TableRow key={c.sku}>
												<TableCell>
													<ProductLink sku={c.sku} />
													<div className="text-xs text-muted-foreground">
														{c.name}
													</div>
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{c.quantity}
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{formatCount(c.available)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</CardContent>
						</Card>
					)}

					{p.kind !== "bundle" && (
						<Card>
							<CardHeader>
								<CardTitle>Stock by location</CardTitle>
							</CardHeader>
							<CardContent>
								{d.stock.length === 0 ? (
									<p className="text-sm text-muted-foreground">
										No stock recorded anywhere.
									</p>
								) : (
									<Table>
										<TableBody>
											{d.stock.map((s) => (
												<TableRow key={s.location}>
													<TableCell>
														{s.location}{" "}
														{s.kind === "fba" && (
															<Badge variant="outline">FBA</Badge>
														)}
													</TableCell>
													<TableCell
														className={`text-right tabular-nums ${s.onHand < 0 ? "text-destructive" : ""}`}
													>
														{formatCount(s.onHand)}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								)}
							</CardContent>
						</Card>
					)}

					{d.usedIn.length > 0 && (
						<Card>
							<CardHeader>
								<CardTitle>Used in</CardTitle>
								<CardDescription>
									Selling this changes what these can sell
								</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-wrap gap-2">
								{d.usedIn.map((u) => (
									<Badge key={u.sku} variant="secondary" asChild>
										<Link to="/products/$sku" params={{ sku: u.sku }}>
											{u.quantity > 1 && `${u.quantity} × `}
											{u.sku}
										</Link>
									</Badge>
								))}
							</CardContent>
						</Card>
					)}

					{d.group && (
						<Card>
							<CardHeader>
								<CardTitle>Variants</CardTitle>
								<CardDescription>{d.group.name}</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-wrap gap-2">
								{d.variants.map((v) => (
									<Badge
										key={v.sku}
										variant={v.sku === p.sku ? "default" : "outline"}
										asChild
									>
										<Link to="/products/$sku" params={{ sku: v.sku }}>
											{v.variantName ?? v.sku}
										</Link>
									</Badge>
								))}
							</CardContent>
						</Card>
					)}

					<Card>
						<CardHeader>
							<CardTitle>Channel listings</CardTitle>
							{d.aliases.length > 0 && (
								<CardDescription>
									Also sold as {d.aliases.join(", ")} on Amazon
								</CardDescription>
							)}
						</CardHeader>
						<CardContent>
							{d.listings.length === 0 ? (
								<EmptyState icon={Link2} title="No listings yet">
									Listings show here once channels sync and get mapped to this
									product.
								</EmptyState>
							) : (
								<Table>
									<TableBody>
										{d.listings.map((l) => (
											<TableRow key={`${l.store}-${l.externalId}`}>
												<TableCell>{l.store}</TableCell>
												<TableCell className="max-w-xs truncate">
													{l.title}
												</TableCell>
												<TableCell>
													{l.fulfillment === "fba" && (
														<Badge variant="outline">FBA</Badge>
													)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							)}
						</CardContent>
					</Card>
				</div>

				{p.kind !== "bundle" && (
					<Card>
						<CardHeader>
							<CardTitle>History</CardTitle>
							<CardDescription>Latest 50 stock movements</CardDescription>
						</CardHeader>
						<CardContent>
							<MovementTable rows={d.history} />
						</CardContent>
					</Card>
				)}
			</PageBody>
		</>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<div className="text-xs text-muted-foreground">{label}</div>
			<div>{children}</div>
		</div>
	);
}
