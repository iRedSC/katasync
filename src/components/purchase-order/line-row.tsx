import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { RefObject } from "react";
import { BulkChip } from "#/components/bulk-chip";
import { OnPoChip } from "#/components/on-po-chip";
import { Badge } from "#/components/page";
import { ProductImage, SetsChip } from "#/components/product";
import { PurchaseUnitCell } from "#/components/purchase-unit";
import { SetGauge } from "#/components/set-gauge";
import { Tip } from "#/components/ui/tooltip";
import { VelocityGauge } from "#/components/velocity-gauge";
import { formatCount, formatMoney } from "#/lib/format";
import { ids } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { setsOf } from "#/purchasing/sets";
import { isBackOrdered } from "#/purchasing/status";
import {
	type PurchaseOrderDetail,
	setPurchaseLineTerms,
} from "#/server/purchasing";
import { AfterPo } from "./after-po";
import { PriceField, SupplierSkuField, WasSent } from "./inline-fields";
import { refusedByDiscounts } from "./line-actions";
import { AmountCell } from "./line-discounts";
import { isUnsent, sinceSent } from "./po-data";
import { draftQuantity, LockToggle, QuantityField } from "./quantity-field";
import { ReceiveField } from "./receive-field";
import { AddSetButton } from "./set-parts";
import type { Line, LineFocus, LineSet } from "./types";
import { useAction } from "./use-action";

export function LineRow({
	detail: d,
	line: l,
	set,
	focus,
	focusedRow,
	items,
	previewing,
	previewFor,
	toggle,
	onMenu,
	onQuantityDone,
}: {
	detail: PurchaseOrderDetail;
	line: Line;
	set: LineSet | null;
	focus: LineFocus | null;
	focusedRow: RefObject<HTMLTableRowElement | null>;
	items: Map<number, number>;
	previewing: boolean;
	previewFor: (lineId: number) => (quantity: number | null) => void;
	toggle: (lineId: number, open: boolean) => void;
	onMenu: () => void;
	// A quantity opened by focus is done; enter says it was left with Enter.
	onQuantityDone: (enter: boolean) => void;
}) {
	const draft = isUnsent(d.order.status);
	const receiving = d.order.status === "sent";
	const editable = d.order.status !== "cancelled";
	const wasSent = d.order.sentAt !== null;
	const since = sinceSent(l, wasSent);
	const { save } = useAction();
	return (
		<tr
			ref={
				focus !== null && ids.same(focus.lineId, l.id) ? focusedRow : undefined
			}
			onContextMenu={onMenu}
			className={cn(
				"border-t transition-colors first:border-t-0",
				since === "amended" && "bg-info-surface/60",
				since === "adjusted" && "bg-warning-surface/60",
				focus !== null && ids.same(focus.lineId, l.id) && "bg-info-surface",
				// Nothing is coming: kept to show the supplier didn't send it.
				l.quantity === 0 && l.received === 0 && "text-muted-foreground",
			)}
		>
			<td className="relative w-full px-4 py-2 whitespace-normal!">
				{set && (
					<button
						type="button"
						aria-expanded={set.open}
						aria-label={`${set.open ? "Hide" : "Show"} the parts of ${l.sku}`}
						onClick={() => toggle(l.id, !set.open)}
						className="absolute top-1/2 left-0.5 -translate-y-1/2 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
					>
						<ChevronRight
							className={cn(
								"size-3.5 transition-transform",
								set.open && "rotate-90",
							)}
							strokeWidth={2.5}
						/>
					</button>
				)}
				<div className={cn("flex items-center gap-3", draft && "min-w-72")}>
					<ProductImage src={l.imageUrl} />
					<div className="min-w-0">
						<Link
							to="/products/$sku"
							params={{ sku: l.sku }}
							className="block hover:underline"
						>
							{/* Wraps instead of cutting off: on a PO the full name matters. */}
							<span className="line-clamp-2 font-medium">
								{l.name}
								{l.variantName && (
									<span className="ml-1.5 rounded-md bg-surface px-1.5 text-xs font-normal text-muted-foreground">
										{l.variantName}
									</span>
								)}
							</span>
						</Link>
						<div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
							<span>
								{l.sku}
								{set && (
									<>
										{" · "}
										<button
											type="button"
											onClick={() => toggle(l.id, !set.open)}
											className="cursor-pointer hover:text-foreground hover:underline"
										>
											Set of {set.parts.length}{" "}
											{set.parts.length === 1 ? "part" : "parts"}
										</button>
									</>
								)}
								{since === "amended" && (
									<span className="text-info-text"> · Amended</span>
								)}
								{since === "adjusted" && (
									<span className="text-warning-text"> · Adjusted</span>
								)}
								{isBackOrdered(l) && (
									<span className="font-semibold text-warning-text">
										{" "}
										· Back-ordered
									</span>
								)}
							</span>
							<OnPoChip pos={l.otherPos} />
							<SetsChip sets={l.why?.sets ?? null} />
							{l.bulk && (
								<BulkChip
									list={l.bulk}
									unit={l.unit}
									order={l}
									onOrder={
										draft && !previewing
											? (at) => {
													if (
														!refusedByDiscounts(l, { quantity: at.minQuantity })
													)
														save(
															draftQuantity(
																l,
																d.order.id,
																at.minQuantity,
																at.cost,
															),
														);
												}
											: undefined
									}
								/>
							)}
							{set && (
								<AddSetButton
									line={l}
									parts={set.parts.map((p) => p.part)}
									sets={setsOf(l)}
									supplierId={d.supplier.id}
									disabled={previewing}
								/>
							)}
						</div>
					</div>
				</div>
			</td>
			<td className="px-3 py-2">
				<SupplierSkuField
					line={l}
					purchaseOrderId={d.order.id}
					supplierId={d.supplier.id}
				/>
			</td>
			<td className="px-3 py-2">
				<PurchaseUnitCell
					label={l.sku}
					value={l}
					cost={l.unitCost}
					units={draft ? d.units : undefined}
					saving={{
						save: (terms) =>
							setPurchaseLineTerms({
								data: {
									purchaseOrderId: d.order.id,
									productId: l.productId,
									...terms,
									makeDefault: false,
								},
							}),
						// Only while this PO's supplier sells it can its terms change.
						...(l.linkSupplierId === d.supplier.id
							? {
									current: {
										unit: l.defaultUnit ?? "EACH",
										packSize: l.defaultPackSize ?? 1,
										supplierCount: l.defaultSupplierCount ?? 1,
										minimumQuantity: l.defaultMinimum ?? 1,
									},
									saveDefault: (terms) =>
										setPurchaseLineTerms({
											data: {
												purchaseOrderId: d.order.id,
												productId: l.productId,
												...terms,
												makeDefault: true,
											},
										}),
								}
							: {
									noDefaultReason: "Not in a catalog this supplier carries",
								}),
					}}
				/>
			</td>
			{!draft && (
				<td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
					{l.sentQuantity === null ? "—" : formatCount(l.sentQuantity)}
				</td>
			)}
			<td className="px-3 py-2 text-right font-semibold tabular-nums">
				{editable ? (
					<div className="group/qty inline-flex items-center gap-1">
						{draft && <LockToggle line={l} purchaseOrderId={d.order.id} />}
						<QuantityField
							key={`q${l.quantity}`}
							line={l}
							purchaseOrderId={d.order.id}
							draft={draft}
							open={
								focus !== null && ids.same(focus.lineId, l.id)
									? focus.nonce
									: null
							}
							onDone={onQuantityDone}
							onPreview={previewFor(l.id)}
						/>
					</div>
				) : (
					formatCount(l.quantity)
				)}
			</td>
			{draft && (
				<td className="px-3 py-2">
					{set ? (
						<div className="flex justify-center">
							<SetGauge coverage={set.coverage} />
						</div>
					) : (
						<AfterPo
							onHand={l.onHand}
							range={l.stockRange}
							ordered={items.get(l.productId) ?? 0}
						/>
					)}
				</td>
			)}
			{draft && (
				<td className="px-3 py-2">
					<VelocityGauge why={l.why} onPo={l} />
				</td>
			)}
			<td className="px-3 py-2 whitespace-nowrap tabular-nums">
				<div className="flex items-center justify-end gap-0.5">
					<WasSent
						line={l}
						shows={l.sentUnitCost !== l.unitCost}
						was={`Sent at ${formatMoney(l.sentUnitCost)}`}
					/>
					{l.kind === "bundle" ? (
						<span className="text-muted-foreground">As parts</span>
					) : editable ? (
						<PriceField line={l} purchaseOrderId={d.order.id} draft={draft} />
					) : (
						formatMoney(l.unitCost)
					)}
				</div>
			</td>
			<td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">
				{set ? (
					<Tip content="Its parts at their prices. The total rounds up to whole units">
						<span>{set.amount === null ? "—" : formatMoney(set.amount)}</span>
					</Tip>
				) : (
					<AmountCell
						line={l}
						purchaseOrderId={d.order.id}
						draft={draft}
						editable={editable}
					/>
				)}
			</td>
			{!draft && (
				<td className="px-4 py-2 text-right whitespace-nowrap">
					{l.quantity === 0 && l.received === 0 ? (
						<Badge>None coming</Badge>
					) : receiving && l.received < l.quantity ? (
						<ReceiveField line={l} purchaseOrderId={d.order.id} />
					) : (
						<Badge tone={l.received >= l.quantity ? "success" : undefined}>
							{formatCount(l.received)} of {formatCount(l.quantity)}
						</Badge>
					)}
				</td>
			)}
		</tr>
	);
}
