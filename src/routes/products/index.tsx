import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { PageBody, PageHeader } from "#/components/page";
import { KindBadge, ProductImage } from "#/components/product";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { formatCount, formatMoney } from "#/lib/format";
import { listProducts } from "#/server/catalog";

export const Route = createFileRoute("/products/")({
	loader: () => listProducts(),
	component: Products,
});

const PAGE = 100;

function Products() {
	const products = Route.useLoaderData();
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState("all");
	const [stock, setStock] = useState("all");
	const [shown, setShown] = useState(PAGE);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return products.filter(
			(p) =>
				(kind === "all" || p.kind === kind) &&
				(stock === "all" ||
					(stock === "out" && p.available === 0) ||
					(stock === "oversold" && (p.onHand ?? 0) < 0)) &&
				(q === "" ||
					p.sku.toLowerCase().includes(q) ||
					p.name.toLowerCase().includes(q) ||
					p.category?.toLowerCase().includes(q)),
		);
	}, [products, query, kind, stock]);

	return (
		<>
			<PageHeader
				title="Products"
				description={`${formatCount(products.length)} products`}
			/>
			<PageBody>
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative w-full max-w-sm">
						<Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
						<Input
							placeholder="Search SKU, name, or category"
							className="pl-8"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setShown(PAGE);
							}}
						/>
					</div>
					<Select value={kind} onValueChange={setKind}>
						<SelectTrigger className="w-36">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All kinds</SelectItem>
							<SelectItem value="simple">Simple</SelectItem>
							<SelectItem value="kit">Kits</SelectItem>
							<SelectItem value="bundle">Bundles</SelectItem>
						</SelectContent>
					</Select>
					<Select value={stock} onValueChange={setStock}>
						<SelectTrigger className="w-40">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">Any stock</SelectItem>
							<SelectItem value="out">Out of stock</SelectItem>
							<SelectItem value="oversold">Oversold</SelectItem>
						</SelectContent>
					</Select>
					<span className="ml-auto text-sm text-muted-foreground">
						{formatCount(filtered.length)} shown
					</span>
				</div>

				<div className="rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Product</TableHead>
								<TableHead>Kind</TableHead>
								<TableHead>Category</TableHead>
								<TableHead className="text-right">On hand</TableHead>
								<TableHead className="text-right">Available</TableHead>
								<TableHead className="text-right">Unit cost</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{filtered.slice(0, shown).map((p) => (
								<TableRow
									key={p.id}
									className="cursor-pointer"
									onClick={() =>
										navigate({ to: "/products/$sku", params: { sku: p.sku } })
									}
								>
									<TableCell>
										<div className="flex items-center gap-3">
											<ProductImage src={p.imageUrl} />
											<div className="min-w-0">
												<div className="max-w-md truncate font-medium">
													{p.name}
													{p.variantName && (
														<span className="text-muted-foreground">
															{" "}
															· {p.variantName}
														</span>
													)}
												</div>
												<div className="font-mono text-xs text-muted-foreground">
													{p.sku}
												</div>
											</div>
										</div>
									</TableCell>
									<TableCell>
										<KindBadge kind={p.kind} />
									</TableCell>
									<TableCell className="text-muted-foreground">
										{p.category ?? "—"}
									</TableCell>
									<TableCell
										className={`text-right tabular-nums ${(p.onHand ?? 0) < 0 ? "text-destructive" : ""}`}
									>
										{p.onHand === null ? "—" : formatCount(p.onHand)}
									</TableCell>
									<TableCell className="text-right font-medium tabular-nums">
										{formatCount(p.available)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{formatMoney(p.unitCost)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
				{shown < filtered.length && (
					<Button
						variant="outline"
						className="self-center"
						onClick={() => setShown((n) => n + PAGE)}
					>
						Show more
					</Button>
				)}
			</PageBody>
		</>
	);
}
