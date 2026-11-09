import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { Fragment } from "react";
import { BulkChip } from "#/components/bulk-chip";
import { OnPoChip } from "#/components/on-po-chip";
import { Badge } from "#/components/page";
import { PriorityRank } from "#/components/priority-score";
import { ProductImage, SetsChip } from "#/components/product";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatMoney } from "#/lib/format";
import type { Sales } from "#/purchasing/reorder/profit";
import type { Recommendation } from "../types";
import type { Candidate } from "./candidates";

export function Row({
	c,
	rank,
	lineId,
	adding,
	disabled,
	onAdd,
	onGoToLine,
}: {
	c: Candidate;
	// Its place among the supplier's products, P1 first.
	rank: number | null;
	// Its line on this PO, once it's there.
	lineId: number | undefined;
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
							{c.supplierSku && c.supplierSku !== c.sku && (
								<span>Theirs {c.supplierSku}</span>
							)}
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
			<td className="px-3 py-2 text-right tabular-nums">
				{c.kind === "bundle" ? (
					<span className="text-muted-foreground">—</span>
				) : (
					<>
						{formatCount(c.onHand)}
						{(c.why?.onOrder ?? 0) > 0 && (
							<Tip content="On sent POs, not here yet">
								<span className="ml-1 text-xs text-muted-foreground">
									+{formatCount(c.why?.onOrder ?? 0)}
								</span>
							</Tip>
						)}
					</>
				)}
			</td>
			<td className="px-3 py-2 text-right tabular-nums">
				<SalesCell sales={c.why?.sales ?? null} />
			</td>
			<td className="px-3 py-2">
				<PriorityRank priority={c.why?.priority ?? null} rank={rank} />
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
					<div className="flex items-center justify-end gap-2">
						{/* What Add puts on: reorder's suggestion, filled to max. */}
						<span className="text-muted-foreground tabular-nums">
							{formatCount(c.quantity)}
							{c.terms && c.terms.unit !== "EACH" && (
								<span className="ml-1 text-xs">
									{c.terms.unit.toLowerCase()}
								</span>
							)}
						</span>
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
					</div>
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

// Units sold over 30 days; hovering shows a week to a year.
function SalesCell({ sales }: { sales: Sales | null }) {
	if (!sales) return <span className="text-muted-foreground">—</span>;
	const rows: [string, number][] = [
		["7 days", sales.d7],
		["30 days", sales.d30],
		["3 months", sales.d90],
		["6 months", sales.d180],
		["1 year", sales.d365],
	];
	return (
		<Tip
			content={
				<dl className="grid grid-cols-[auto_auto] gap-x-4 tabular-nums">
					{rows.map(([label, n]) => (
						<Fragment key={label}>
							<dt>{label}</dt>
							<dd className="text-right">{formatCount(n)}</dd>
						</Fragment>
					))}
				</dl>
			}
		>
			<span className={sales.d30 === 0 ? "text-muted-foreground" : undefined}>
				{formatCount(sales.d30)}
			</span>
		</Tip>
	);
}
