import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { BulkChip } from "#/components/bulk-chip";
import { OnPoChip } from "#/components/on-po-chip";
import { Badge } from "#/components/page";
import { ProductImage, SetsChip } from "#/components/product";
import { PurchaseUnitCell } from "#/components/purchase-unit";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { VelocityGauge } from "#/components/velocity-gauge";
import { formatCount, formatMoney } from "#/lib/format";
import { AfterPo } from "../after-po";
import type { Recommendation } from "../types";
import type { Candidate } from "./candidates";

export function Row({
	c,
	lineId,
	ordered,
	adding,
	disabled,
	onAdd,
	onGoToLine,
}: {
	c: Candidate;
	// Its line on this PO, once it's there.
	lineId: number | undefined;
	// What this PO orders of it with this row added, in single items.
	ordered: number;
	adding: boolean;
	disabled: boolean;
	onAdd: () => void;
	onGoToLine: (lineId: number) => void;
}) {
	return (
		<tr className="border-t first:border-t-0">
			<td className="w-full px-4 py-2 whitespace-normal!">
				<div className="flex min-w-72 items-center gap-3">
					<ProductImage src={c.imageUrl} />
					<div className="min-w-0">
						<Link
							to="/products/$sku"
							params={{ sku: c.sku }}
							className="block hover:underline"
						>
							<span className="line-clamp-2 font-medium">
								{c.name}
								{c.variantName && (
									<span className="ml-1.5 rounded-md bg-surface px-1.5 text-xs font-normal text-muted-foreground">
										{c.variantName}
									</span>
								)}
							</span>
						</Link>
						<div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
							{c.sku}
							<OnPoChip pos={c.otherPos} />
							<SetsChip sets={c.why?.sets ?? null} />
							{c.bulk && (
								<BulkChip
									list={c.bulk.list}
									unit={c.bulk.unit}
									order={{ quantity: c.quantity, unitCost: c.unitCost }}
								/>
							)}
							{c.kind === "bundle" && <span>Tool set</span>}
							{c.kind === "kit" && <span>Kit</span>}
							{c.critical && <Badge tone="info">Essential</Badge>}
							{c.cheaperAt && <CheaperAt at={c.cheaperAt} />}
							{c.warning && (
								<span className="flex items-center gap-1 text-warning-text">
									<AlertTriangle className="size-3" />
									{c.warning.text}
								</span>
							)}
						</div>
					</div>
				</div>
			</td>
			<td className="px-3 py-2">
				<span className="px-1.5 text-muted-foreground">
					{c.supplierSku ?? "—"}
				</span>
			</td>
			<td className="px-3 py-2">
				{c.terms ? (
					<PurchaseUnitCell label={c.sku} value={c.terms} cost={c.unitCost} />
				) : (
					<span className="text-muted-foreground">—</span>
				)}
			</td>
			<td className="px-3 py-2 text-muted-foreground">
				{c.due === null ? (
					""
				) : c.due === "now" ? (
					<Badge tone="warning">Due</Badge>
				) : c.due === 0 ? (
					"Today"
				) : (
					`${formatCount(c.due)}d`
				)}
			</td>
			<td className="px-3 py-2 text-right font-semibold tabular-nums">
				{formatCount(c.quantity)}
			</td>
			<td className="px-3 py-2">
				{c.kind === "bundle" ? (
					<span className="block text-center text-muted-foreground">—</span>
				) : (
					<AfterPo onHand={c.onHand} range={c.range} ordered={ordered} />
				)}
			</td>
			<td className="px-3 py-2">
				{c.why || c.kind === "bundle" ? (
					<VelocityGauge why={c.why} />
				) : (
					<span className="block text-center text-muted-foreground">—</span>
				)}
			</td>
			<td className="px-3 py-2 text-right tabular-nums">
				{c.kind === "bundle" ? (
					<span className="text-muted-foreground">As parts</span>
				) : (
					formatMoney(c.unitCost)
				)}
			</td>
			<td className="px-3 py-2 text-right tabular-nums">
				{c.unitCost === null ? "—" : formatMoney(c.unitCost * c.quantity)}
			</td>
			<td className="px-4 py-2 text-right">
				{lineId !== undefined ? (
					<Tip content="Go to line">
						<Button
							size="sm"
							variant="ghost"
							onClick={() => onGoToLine(lineId)}
						>
							<Check />
							Added
						</Button>
					</Tip>
				) : (
					<Tip content={c.warning?.blocks ? c.warning.text : undefined}>
						<Button
							size="sm"
							variant="outline"
							disabled={disabled || c.warning?.blocks}
							onClick={onAdd}
						>
							{adding && <Loader2 className="animate-spin" />}
							Add
						</Button>
					</Tip>
				)}
			</td>
		</tr>
	);
}

// Another supplier sells it for less, so suggestions put it on theirs. Says
// who and by how much a piece, so adding it here is a choice made knowingly.
function CheaperAt({ at }: { at: NonNullable<Recommendation["cheaperAt"]> }) {
	const saved = at.ours === null ? null : at.ours - at.itemCost;
	return (
		<Tip
			content={`${formatMoney(at.itemCost)} each at ${at.supplierName}${at.ours === null ? "" : `, ${formatMoney(at.ours)} here`}`}
		>
			<span className="inline-flex">
				<Badge tone="warning">
					{saved === null
						? `Priced at ${at.supplierCode}`
						: `${formatMoney(saved)} less at ${at.supplierCode}`}
				</Badge>
			</span>
		</Tip>
	);
}
