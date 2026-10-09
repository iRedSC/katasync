import NumberFlow from "@number-flow/react";
import {
	createFileRoute,
	Link,
	useCanGoBack,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { CountDialog } from "#/components/count-dialog";
import { Badge, Banner, Card, Page, type Tone } from "#/components/page";
import { MovementTable, ProductImage, ProductName } from "#/components/product";
import { Button } from "#/components/ui/button";
import { formatCount, formatMoney } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";
import { getProductDetail, type ProductDetail } from "#/server/catalog";

export const Route = createFileRoute("/products/$sku")({
	loader: ({ params }) => getProductDetail({ data: { sku: params.sku } }),
	component: ProductPage,
});

function ProductPage() {
	const d = Route.useLoaderData();
	const p = d.product;
	const router = useRouter();
	const navigate = useNavigate();
	const canGoBack = useCanGoBack();
	const [counting, setCounting] = useState(false);
	const canCount = p.kind !== "bundle";
	const verdict = getVerdict(d);

	useHotkeys({
		c: () => canCount && setCounting(true),
		Escape: () =>
			canGoBack ? router.history.back() : navigate({ to: "/products" }),
	});

	return (
		<Page
			narrow
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
			{verdict && <Banner tone={verdict.tone} title={verdict.text} />}

			<div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<div className="flex min-w-0 flex-col gap-4">
					<Card>
						<div className="flex items-center gap-4">
							<ProductImage src={p.imageUrl} className="size-24" />
							<div className="min-w-0">
								<p className="text-base font-semibold">{p.name}</p>
								{p.variantName && (
									<p className="text-muted-foreground">{p.variantName}</p>
								)}
								<p className="text-muted-foreground">{p.sku}</p>
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
									<tr className="border-y bg-[#f7f7f7] text-left text-xs text-muted-foreground">
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
									<tr className="border-y bg-[#f7f7f7] text-left text-xs text-muted-foreground">
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
												No stock recorded yet.
											</td>
										</tr>
									)}
									{d.stock.map((s) => (
										<tr key={s.location} className="border-t first:border-t-0">
											<td className="px-4 py-2.5">
												{s.location}
												{s.kind === "fba" && (
													<span className="ml-2">
														<Badge>Amazon FBA</Badge>
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
												? "bg-[#303030] text-white"
												: "bg-[#f1f1f1] hover:bg-[#e3e3e3]",
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
											className="flex gap-2 px-4 py-2 hover:bg-[#f7f7f7]"
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
							<p className="text-muted-foreground">
								Not linked to any store listing yet.
							</p>
						) : (
							<ul className="flex flex-col gap-1.5">
								{d.listings.map((l) => (
									<li
										key={`${l.store}-${l.externalId}`}
										className="flex justify-between gap-2"
									>
										<span>{l.store}</span>
										{l.fulfillment === "fba" && (
											<Badge>Fulfilled by Amazon</Badge>
										)}
									</li>
								))}
								{d.aliases.length > 0 && (
									<li className="text-muted-foreground">
										Amazon SKU {d.aliases.join(", ")}
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
				/>
			)}
		</Page>
	);
}

// One sentence a person can act on, worked out from the numbers.
function getVerdict(d: ProductDetail): { tone: Tone; text: ReactNode } | null {
	if (d.product.kind === "bundle") {
		const missing = d.components.filter((c) => c.available < c.quantity);
		if (missing.length > 0) {
			return {
				tone: "warning",
				text: (
					<>
						This set can't be sold. Not enough{" "}
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
		const limiting = d.components.filter(
			(c) => Math.floor(c.available / c.quantity) === d.available,
		);
		return {
			tone: "warning",
			text:
				limiting.length === 1 ? (
					<>
						Only {formatCount(d.available)} left. {limiting[0].name} runs out
						first.
					</>
				) : (
					<>
						Only {formatCount(d.available)} left.{" "}
						{limiting.length === d.components.length
							? "Every part runs"
							: `${limiting.length} parts run`}{" "}
						out at the same time.
					</>
				),
		};
	}
	const onHand = d.stock.reduce((sum, s) => sum + s.onHand, 0);
	if (onHand < 0) {
		return {
			tone: "critical",
			text: (
				<>
					Sold {formatCount(-onHand)} more than we have. Count the shelf, or a
					restock is overdue.
				</>
			),
		};
	}
	return null;
}

// Only what's filled in. Empty fields aren't worth a glance.
function Details({ d }: { d: ProductDetail }) {
	const p = d.product;
	const rows: [string, ReactNode][] = [];
	if (p.category) rows.push(["Type", p.category]);
	if (p.unitCost !== null) rows.push(["Cost", formatMoney(p.unitCost)]);
	if (p.barcode) rows.push(["Barcode", p.barcode]);
	if (p.weightGrams) rows.push(["Weight", `${formatCount(p.weightGrams)} g`]);
	if (p.lengthMm && p.widthMm && p.heightMm) {
		rows.push(["Box", `${p.lengthMm} × ${p.widthMm} × ${p.heightMm} mm`]);
	}
	if (rows.length === 0) return null;
	return (
		<Card title="Product organization">
			<dl className="flex flex-col gap-2">
				{rows.map(([label, value]) => (
					<div key={label}>
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="tabular-nums">{value}</dd>
					</div>
				))}
			</dl>
		</Card>
	);
}
