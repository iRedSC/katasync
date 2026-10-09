import {
	createFileRoute,
	Link,
	useCanGoBack,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { ClipboardCheck } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CountDialog } from "#/components/count-dialog";
import { PageBody, PageHeader, Section, type Tone } from "#/components/page";
import { MovementTable, ProductImage } from "#/components/product";
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
		<>
			<PageHeader
				title={
					p.kind === "bundle"
						? "Tool set"
						: p.kind === "kit"
							? "Kit"
							: "Product"
				}
				actions={
					canCount && (
						<Button onClick={() => setCounting(true)}>
							<ClipboardCheck />
							Count shelf
							<kbd className="ml-1 text-xs opacity-60">C</kbd>
						</Button>
					)
				}
			/>
			<PageBody>
				<div className="flex flex-col gap-8 md:flex-row md:items-center">
					<ProductImage src={p.imageUrl} className="size-36" />
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<h2 className="text-2xl font-semibold tracking-tight">{p.name}</h2>
						{p.variantName && (
							<div className="text-lg text-muted-foreground">
								{p.variantName}
							</div>
						)}
						<div className="font-mono text-sm text-muted-foreground">
							{p.sku}
						</div>
					</div>
					<div className="md:text-right">
						<div
							className={cn(
								"text-6xl font-semibold tracking-tight tabular-nums",
								d.available === 0 && "text-muted-foreground/50",
							)}
						>
							{formatCount(d.available)}
						</div>
						<div className="text-muted-foreground">can be sold</div>
					</div>
				</div>

				{verdict && <Verdict tone={verdict.tone}>{verdict.text}</Verdict>}

				<div className="grid gap-10 lg:grid-cols-2">
					{d.components.length > 0 && (
						<Section
							title={p.kind === "bundle" ? "Parts in this set" : "Built from"}
						>
							<ul className="flex flex-col">
								{d.components.map((c) => {
									const short = c.available < c.quantity;
									return (
										<li key={c.sku}>
											<Link
												to="/products/$sku"
												params={{ sku: c.sku }}
												className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent"
											>
												<span
													className={cn(
														"size-2 shrink-0 rounded-full",
														short ? "bg-warn" : "bg-transparent",
													)}
												/>
												<div className="min-w-0 flex-1">
													<div className="truncate">
														{c.quantity > 1 && (
															<span className="font-semibold">
																{c.quantity} ×{" "}
															</span>
														)}
														{c.name}
														{c.variantName && (
															<span className="text-muted-foreground">
																{" "}
																· {c.variantName}
															</span>
														)}
													</div>
													<div className="font-mono text-xs text-muted-foreground">
														{c.sku}
													</div>
												</div>
												<div className="text-right">
													<div
														className={cn(
															"font-semibold tabular-nums",
															short && "text-muted-foreground/60",
														)}
													>
														{formatCount(c.available)}
													</div>
													<div className="text-xs text-muted-foreground">
														{short ? "not enough" : "in stock"}
													</div>
												</div>
											</Link>
										</li>
									);
								})}
							</ul>
						</Section>
					)}

					{d.usedIn.length > 0 && (
						<Section
							title={`Part of ${d.usedIn.length} tool ${d.usedIn.length === 1 ? "set" : "sets"}`}
						>
							<div className="flex flex-wrap gap-2">
								{d.usedIn.map((u) => (
									<Link
										key={u.sku}
										to="/products/$sku"
										params={{ sku: u.sku }}
										className="max-w-full truncate rounded-full border px-3 py-1 text-sm hover:bg-accent"
									>
										{u.quantity > 1 && `${u.quantity} × `}
										{u.name}
									</Link>
								))}
							</div>
						</Section>
					)}

					{d.group && d.variants.length > 1 && (
						<Section title="Other sizes and versions">
							<div className="flex flex-wrap gap-2">
								{d.variants.map((v) => (
									<Link
										key={v.sku}
										to="/products/$sku"
										params={{ sku: v.sku }}
										className={cn(
											"rounded-full border px-3 py-1 text-sm",
											v.sku === p.sku
												? "border-foreground bg-foreground text-background"
												: "hover:bg-accent",
										)}
									>
										{v.variantName ?? v.sku}
									</Link>
								))}
							</div>
						</Section>
					)}

					{(d.stock.length > 1 ||
						d.listings.length > 0 ||
						d.aliases.length > 0) && (
						<Section title="Where it lives and sells">
							<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
								{d.stock.length > 1 &&
									d.stock.map((s) => (
										<Row key={s.location} label={s.location}>
											{formatCount(s.onHand)} on the shelf
										</Row>
									))}
								{d.listings.map((l) => (
									<Row key={`${l.store}-${l.externalId}`} label={l.store}>
										{l.fulfillment === "fba" ? "Shipped by Amazon" : "Listed"}
									</Row>
								))}
								{d.aliases.length > 0 && (
									<Row label="Amazon">Also sold as {d.aliases.join(", ")}</Row>
								)}
							</dl>
						</Section>
					)}

					<Details d={d} />
				</div>

				{canCount && d.history.length > 0 && (
					<Section title="What changed">
						<MovementTable rows={d.history.slice(0, 10)} />
					</Section>
				)}
			</PageBody>

			{canCount && (
				<CountDialog
					open={counting}
					onOpenChange={setCounting}
					sku={p.sku}
					name={p.variantName ? `${p.name} · ${p.variantName}` : p.name}
					locations={d.locations}
					onHandByLocation={new Map(d.stock.map((s) => [s.location, s.onHand]))}
				/>
			)}
		</>
	);
}

// One sentence a person can act on, worked out from the numbers.
function getVerdict(d: ProductDetail): { tone: Tone; text: ReactNode } | null {
	if (d.product.kind === "bundle") {
		const missing = d.components.filter((c) => c.available < c.quantity);
		if (missing.length > 0) {
			return {
				tone: "warn",
				text: (
					<>
						Can't sell this set. Not enough{" "}
						{missing.map((c, i) => (
							<span key={c.sku}>
								{i > 0 && (i === missing.length - 1 ? " or " : ", ")}
								<strong>{c.name}</strong>
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
			tone: "warn",
			text:
				limiting.length === 1 ? (
					<>
						Only {formatCount(d.available)} left.{" "}
						<strong>{limiting[0].name}</strong> runs out first.
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
			tone: "bad",
			text: (
				<>
					Sold <strong>{formatCount(-onHand)}</strong> more than we have. Count
					the shelf, or a restock is overdue.
				</>
			),
		};
	}
	return null;
}

function Verdict({ tone, children }: { tone: Tone; children: ReactNode }) {
	return (
		<div
			className={cn(
				"relative overflow-hidden rounded-xl px-6 py-4 pl-7 text-base",
				tone === "bad" ? "bg-bad/8" : "bg-warn/12",
			)}
		>
			<span
				className={cn(
					"absolute inset-y-0 left-0 w-1.5",
					tone === "bad" ? "bg-bad" : "bg-warn",
				)}
			/>
			{children}
		</div>
	);
}

// Only what's filled in. Empty fields aren't worth a glance.
function Details({ d }: { d: ProductDetail }) {
	const p = d.product;
	const rows: [string, ReactNode][] = [];
	if (p.unitCost !== null) rows.push(["Cost", formatMoney(p.unitCost)]);
	if (p.category) rows.push(["Type", p.category]);
	if (p.barcode)
		rows.push([
			"Barcode",
			<span key="barcode" className="font-mono">
				{p.barcode}
			</span>,
		]);
	if (p.weightGrams) rows.push(["Weight", `${formatCount(p.weightGrams)} g`]);
	if (p.lengthMm && p.widthMm && p.heightMm) {
		rows.push(["Box", `${p.lengthMm} × ${p.widthMm} × ${p.heightMm} mm`]);
	}
	if (rows.length === 0) return null;
	return (
		<Section title="Details">
			<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
				{rows.map(([label, value]) => (
					<Row key={label} label={label}>
						{value}
					</Row>
				))}
			</dl>
		</Section>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd>{children}</dd>
		</>
	);
}
