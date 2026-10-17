import { Command as CommandPrimitive } from "cmdk";
import { AlertTriangle, LayoutList, Loader2, Search } from "lucide-react";
import { type Ref, useEffect, useState } from "react";
import { ProductImage } from "#/components/product";
import { Button } from "#/components/ui/button";
import { formatCount, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import {
	type PurchaseOrderMatch,
	searchForPurchaseOrder,
} from "#/server/purchasing";

export type { PurchaseOrderMatch };

type SearchState =
	| { state: "idle" }
	| { state: "searching"; query: string; results: PurchaseOrderMatch[] }
	| { state: "done"; query: string; results: PurchaseOrderMatch[] }
	| { state: "failed"; query: string; message: string };

// Searches products to add to a PO as someone types. Waits for a pause, and
// only the newest query's answer is kept, so a slow early reply can't
// replace a later one. The last results stay up while the next search runs.
export function usePurchaseOrderSearch(purchaseOrderId: number, query: string) {
	const [search, setSearch] = useState<SearchState>({ state: "idle" });
	const q = query.trim();
	useEffect(() => {
		if (q === "") {
			setSearch({ state: "idle" });
			return;
		}
		let current = true;
		setSearch((s) => ({
			state: "searching",
			query: q,
			results: s.state === "idle" || s.state === "failed" ? [] : s.results,
		}));
		const timer = setTimeout(() => {
			searchForPurchaseOrder({ data: { purchaseOrderId, query: q } }).then(
				(results) => current && setSearch({ state: "done", query: q, results }),
				(err) =>
					current &&
					setSearch({
						state: "failed",
						query: q,
						message: err instanceof Error ? err.message : String(err),
					}),
			);
		}, 150);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [purchaseOrderId, q]);
	return search;
}

// Why a product might be the wrong one to add, or null when it's fine.
export function matchWarning(
	m: PurchaseOrderMatch,
	sent: boolean,
): { text: string; blocks: boolean } | null {
	if (m.kind === "bundle" && sent)
		return { text: "Tool set: add the parts that came", blocks: true };
	if (m.supplierId === null) return { text: "No supplier", blocks: false };
	if (!m.fromThisSupplier)
		return { text: `Bought from ${m.supplierName}`, blocks: false };
	return null;
}

// Adds a product to the PO: type a name, SKU, barcode, or the supplier's SKU,
// or scan one. Arrows pick, Enter adds. Matches open below the field, inside
// the card, so nothing clips them. Browse opens the supplier's whole list.
export function ProductPicker({
	ref,
	purchaseOrderId,
	sent,
	busy,
	onPick,
	onBrowse,
}: {
	ref?: Ref<HTMLInputElement>;
	purchaseOrderId: number;
	// Sent POs: what's added stays here, the supplier isn't told.
	sent: boolean;
	busy: boolean;
	// Resolves to true once it's done, which clears the field.
	onPick: (match: PurchaseOrderMatch) => Promise<boolean>;
	onBrowse: () => void;
}) {
	const [query, setQuery] = useState("");
	const search = usePurchaseOrderSearch(purchaseOrderId, query);
	const results =
		search.state === "idle" || search.state === "failed" ? [] : search.results;

	async function pick(m: PurchaseOrderMatch) {
		if (busy) return;
		if (await onPick(m)) setQuery("");
	}

	return (
		<CommandPrimitive
			shouldFilter={false}
			// Escape clears first, then leaves the field.
			onKeyDown={(e) => {
				if (e.key !== "Escape") return;
				e.stopPropagation();
				if (query) setQuery("");
				else (e.target as HTMLElement).blur();
			}}
			className="border-t"
		>
			<div className="flex items-center gap-2 px-4 py-2">
				<Search className="size-4 shrink-0 text-muted-foreground" />
				<CommandPrimitive.Input
					ref={ref}
					value={query}
					onValueChange={setQuery}
					placeholder="Add: name, SKU, barcode, or their SKU"
					className="h-9 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
				/>
				{search.state === "searching" && (
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				)}
				{query === "" && (
					<kbd className="rounded border px-1.5 text-xs text-muted-foreground">
						/
					</kbd>
				)}
				<Button type="button" size="sm" variant="outline" onClick={onBrowse}>
					<LayoutList />
					Browse
				</Button>
			</div>
			{query.trim() !== "" && (
				<CommandPrimitive.List className="max-h-96 overflow-y-auto border-t p-1">
					{search.state === "failed" ? (
						<p className="px-3 py-4 text-critical-text">{search.message}</p>
					) : (
						search.state === "done" &&
						results.length === 0 && (
							<p className="px-3 py-4 text-muted-foreground">No matches</p>
						)
					)}
					{results.map((m) => {
						const warning = matchWarning(m, sent);
						return (
							<CommandPrimitive.Item
								key={m.productId}
								value={String(m.productId)}
								disabled={warning?.blocks}
								onSelect={() => pick(m)}
								className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[selected=true]:bg-surface"
							>
								<ProductImage src={m.imageUrl} className="size-9" />
								<div className="min-w-0 flex-1">
									<div className="truncate font-medium">
										{m.name}
										{m.variantName && (
											<span className="font-normal text-muted-foreground">
												{" "}
												· {m.variantName}
											</span>
										)}
									</div>
									<div className="flex items-center gap-2 text-xs text-muted-foreground">
										<span>{m.sku}</span>
										{m.supplierSku && <span>Their SKU {m.supplierSku}</span>}
										{warning && (
											<span className="flex items-center gap-1 text-warning-text">
												<AlertTriangle className="size-3" />
												{warning.text}
											</span>
										)}
									</div>
								</div>
								<div className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
									<div>{formatCount(m.onHand)} on hand</div>
									{m.cost !== null && (
										<div>
											{formatMoney(m.cost)}
											{m.packSize !== null && m.packSize > 1 && ` / ${m.unit}`}
										</div>
									)}
								</div>
								<span
									className={cn(
										"w-24 shrink-0 text-right text-xs font-medium",
										m.lineId === null ? "text-link" : "text-muted-foreground",
									)}
								>
									{m.lineId === null ? "Add" : "On this PO, go"}
								</span>
							</CommandPrimitive.Item>
						);
					})}
				</CommandPrimitive.List>
			)}
		</CommandPrimitive>
	);
}
