import NumberFlow from "@number-flow/react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/page";
import { useDraft } from "#/lib/draft";
import { formatCount } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import type { ProductDetail } from "#/server/catalog";
import { saveShelfTarget } from "#/server/transfers";

// Stock at each location. The retail store always has a row, even before
// it holds any, with the target refills top it up to.
export function StockTable({
	productId,
	stock,
	locations,
	targets,
}: {
	productId: number;
	stock: ProductDetail["stock"];
	locations: ProductDetail["locations"];
	targets: ProductDetail["targets"];
}) {
	const retail = locations.find((l) => l.kind === "retail");
	const rows =
		retail && !stock.some((s) => s.location === retail.name)
			? [
					...stock,
					{ location: retail.name, kind: "retail" as const, onHand: 0 },
				]
			: stock;
	return (
		<table className="w-full">
			<thead>
				<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
					<th className="px-4 py-2 font-medium">Location</th>
					{retail && (
						<th className="px-4 py-2 text-right font-medium">Refill to</th>
					)}
					<th className="px-4 py-2 text-right font-medium">On hand</th>
				</tr>
			</thead>
			<tbody>
				{rows.length === 0 && (
					<tr>
						<td className="px-4 py-2.5 text-muted-foreground" colSpan={3}>
							No stock recorded.
						</td>
					</tr>
				)}
				{rows.map((s) => (
					<tr key={s.location} className="border-t first:border-t-0">
						<td className="px-4 py-2.5">
							{s.location}
							{s.kind === "fba" && (
								<span className="ml-2">
									<Badge>Amazon's, not ours to ship</Badge>
								</span>
							)}
							{s.kind === "retail" && (
								<span className="ml-2">
									<Badge>Ships when the warehouse is out</Badge>
								</span>
							)}
						</td>
						{retail && (
							<td className="px-4 py-2.5 text-right">
								{s.kind === "retail" && (
									<TargetInput
										productId={productId}
										locationId={retail.id}
										store={retail.name}
										value={
											targets.find((t) => t.locationId === retail.id)?.target ??
											null
										}
									/>
								)}
							</td>
						)}
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
	);
}

// Blank means no target, so refills leave the product alone there.
function TargetInput({
	productId,
	locationId,
	store,
	value,
}: {
	productId: number;
	locationId: number;
	store: string;
	value: number | null;
}) {
	const shown = value === null ? "" : String(value);
	// What's typed stays until saved: a save coming back never overwrites text
	// typed while it was on its way, and a failed one leaves the field marked.
	const { draft: text, setDraft } = useDraft(shown);
	const [failed, setFailed] = useState(false);
	const setText = (next: string) => {
		setFailed(false);
		setDraft(next);
	};
	async function commit() {
		if (text === shown) return;
		const target = text === "" ? null : Number(text);
		const r = await optimism.change({
			send: () => saveShelfTarget({ data: { productId, locationId, target } }),
		});
		if (!r) return setFailed(true);
		setFailed(false);
		toast.success(
			target === null || target === 0
				? `Refills leave this alone at ${store}`
				: `Refills top ${store} up to ${formatCount(target)}`,
		);
	}
	return (
		<input
			value={text}
			inputMode="numeric"
			placeholder="None"
			aria-label={`Refill ${store} to`}
			aria-invalid={failed || undefined}
			onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
			}}
			className="h-7 w-16 rounded-lg bg-surface px-2 text-right tabular-nums outline-none placeholder:text-faint focus:ring-2 focus:ring-ring aria-invalid:ring-2 aria-invalid:ring-critical"
		/>
	);
}
