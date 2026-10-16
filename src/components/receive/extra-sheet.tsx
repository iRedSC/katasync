import { AlertTriangle, ImageOff, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
	matchWarning,
	type PurchaseOrderMatch,
	usePurchaseOrderSearch,
} from "#/components/po-product-picker";

// Something in the box that isn't on the PO: find it by name, SKU, barcode,
// or the supplier's SKU (a scanner types into the field), then pick it to
// count it.
export function ExtraSheet({
	purchaseOrderId,
	onPick,
	onClose,
}: {
	purchaseOrderId: number;
	onPick: (match: PurchaseOrderMatch) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const search = usePurchaseOrderSearch(purchaseOrderId, query);
	const results =
		search.state === "searching" || search.state === "done"
			? search.results
			: [];

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Something else came"
			className="fixed inset-0 z-50 flex flex-col bg-background px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
		>
			<div className="flex items-center gap-3 pb-3">
				<input
					value={query}
					// biome-ignore lint/a11y/noAutofocus: opened to type or scan
					autoFocus
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						// A scan ends with Enter: take the best match.
						const first = results[0];
						if (
							e.key === "Enter" &&
							first &&
							!matchWarning(first, true)?.blocks
						)
							onPick(first);
					}}
					placeholder="What came? Name, SKU, or scan"
					className="h-14 min-w-0 flex-1 rounded-2xl bg-card px-4 text-lg shadow-card outline-none"
				/>
				<button
					type="button"
					aria-label="Close"
					onClick={onClose}
					className="flex size-14 shrink-0 items-center justify-center rounded-full bg-card shadow-card active:bg-surface-strong"
				>
					<X className="size-7" />
				</button>
			</div>

			<ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
				{search.state === "searching" && results.length === 0 && (
					<li className="flex justify-center py-8 text-muted-foreground">
						<Loader2 className="size-6 animate-spin" />
					</li>
				)}
				{search.state === "failed" && (
					<li className="py-8 text-center text-lg text-critical-text">
						{search.message}
					</li>
				)}
				{search.state === "done" && results.length === 0 && (
					<li className="py-8 text-center text-lg text-muted-foreground">
						Nothing matches "{search.query}"
					</li>
				)}
				{results.map((m) => {
					const warning = matchWarning(m, true);
					return (
						<li key={m.productId}>
							<button
								type="button"
								disabled={warning?.blocks}
								onClick={() => onPick(m)}
								className="flex w-full items-center gap-3 rounded-2xl bg-card p-3 text-left shadow-card active:bg-surface disabled:opacity-50"
							>
								{m.imageUrl ? (
									<img
										src={m.imageUrl}
										alt=""
										className="size-14 shrink-0 rounded-xl bg-surface-strong object-cover"
									/>
								) : (
									<div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-surface-strong text-faint">
										<ImageOff className="size-6" />
									</div>
								)}
								<div className="min-w-0 flex-1">
									<p className="line-clamp-2 text-lg leading-snug font-semibold">
										{m.name}
										{m.variantName && (
											<span className="font-normal text-muted-foreground">
												{" "}
												· {m.variantName}
											</span>
										)}
									</p>
									<p className="truncate font-mono text-xs text-muted-foreground">
										{m.sku}
									</p>
									{m.lineId !== null ? (
										<p className="text-sm font-semibold text-link">
											Already on this PO
										</p>
									) : (
										warning && (
											<p className="flex items-center gap-1 text-sm font-semibold text-warning-text">
												<AlertTriangle className="size-4" />
												{warning.text}
											</p>
										)
									)}
								</div>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
