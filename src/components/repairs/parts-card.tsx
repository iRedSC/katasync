import { Minus, Plus, Trash2 } from "lucide-react";
import { Card } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import {
	AddProduct,
	type IndexedProduct,
} from "#/components/transfers/add-product";
import { Button } from "#/components/ui/button";
import { formatMoney } from "#/lib/format";
import type { Detail } from "./repair-data";

// Parts put into the tool, charged at their Shopify price; their stock
// comes off when the paid order syncs in. Below them, what was added to
// the draft order in Shopify, which katasync leaves alone.

type Part = Detail["parts"][number];

export function PartsCard({
	d,
	index,
	editable,
	onSet,
}: {
	d: Detail;
	index: IndexedProduct[];
	editable: boolean;
	onSet: (
		part: Pick<Part, "productId" | "sku" | "name" | "variantName" | "imageUrl">,
		quantity: number,
	) => void;
}) {
	const others = d.draft.kind === "open" ? d.draft.others : [];
	return (
		<Card title="Parts" flush>
			<ul>
				{d.parts.map((p) => (
					<li
						key={p.productId}
						className="flex items-center gap-3 border-t px-4 py-2"
					>
						<ProductImage src={p.imageUrl} className="size-8" />
						<div className="min-w-0 flex-1">
							<ProductName name={p.name} variantName={p.variantName} />
							<div className="text-xs text-muted-foreground">
								{p.sku}
								{!p.onShopify && (
									<span className="text-critical-text">, not on Shopify</span>
								)}
							</div>
						</div>
						{editable ? (
							<span className="flex items-center gap-1">
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="One fewer"
									disabled={p.quantity <= 1}
									onClick={() => onSet(p, p.quantity - 1)}
								>
									<Minus />
								</Button>
								<span className="w-6 text-center font-semibold tabular-nums">
									{p.quantity}
								</span>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="One more"
									onClick={() => onSet(p, p.quantity + 1)}
								>
									<Plus />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Take off"
									onClick={() => onSet(p, 0)}
								>
									<Trash2 />
								</Button>
							</span>
						) : (
							<span className="font-semibold tabular-nums">× {p.quantity}</span>
						)}
					</li>
				))}
			</ul>
			{editable && (
				<div className="border-t">
					<AddProduct
						products={index}
						exclude={new Set(d.parts.map((p) => p.productId))}
						onAdd={(p) =>
							onSet(
								{
									productId: p.id,
									sku: p.sku,
									name: p.name,
									variantName: p.variantName,
									imageUrl: p.imageUrl,
								},
								1,
							)
						}
					/>
				</div>
			)}
			{others.length > 0 && (
				<>
					<h3 className="border-t px-4 pt-3 pb-1 text-xs font-semibold text-muted-foreground">
						Added in Shopify
					</h3>
					<ul>
						{others.map((o) => (
							<li key={o.uuid} className="flex items-center gap-3 px-4 py-1.5">
								<span className="min-w-0 flex-1 truncate">{o.title}</span>
								<span className="tabular-nums text-muted-foreground">
									× {o.quantity}
								</span>
								<span className="w-20 text-right tabular-nums">
									{formatMoney(o.total)}
								</span>
							</li>
						))}
					</ul>
				</>
			)}
		</Card>
	);
}
