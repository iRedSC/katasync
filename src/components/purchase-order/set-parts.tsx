import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { Fragment } from "react";
import { ProductImage } from "#/components/product";
import { PurchaseUnitCell } from "#/components/purchase-unit";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { VelocityGauge } from "#/components/velocity-gauge";
import { formatCount, formatMoney } from "#/lib/format";
import { ids } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { type PartState, shortBySupplier } from "#/purchasing/sets";
import { addSetToOtherPos, skipPartOfSet } from "#/server/purchasing";
import { AfterPo } from "./after-po";
import type { Line, SetPart } from "./types";
import { useAction } from "./use-action";

// One part of a set, under its line on a draft, laid out like a line. A part
// bought from this PO's supplier is ordered here; anything else says where it
// comes from instead, or that nobody orders it yet.
export function SetPartRow({
	line,
	part: p,
	state,
	sets,
	ordered,
}: {
	line: Line;
	part: SetPart;
	state: PartState;
	sets: number;
	ordered: number;
}) {
	const { busy, run } = useAction();
	const here = state.kind === "here";
	const items = sets * p.perSet;
	const skip = (skipped: boolean) =>
		run(
			() =>
				skipPartOfSet({
					data: {
						lineId: ids.server(line.id),
						productId: p.productId,
						skipped,
					},
				}),
			(sku) =>
				skipped
					? `${sku} skipped for ${line.sku}`
					: `${sku} is ordered for ${line.sku} again`,
		);
	return (
		<tr className="bg-subtle/60">
			<td className="w-full py-2 pr-4 pl-10 whitespace-normal!">
				<div className="flex min-w-72 items-center gap-3 border-l-2 border-surface-strong pl-3">
					<ProductImage
						src={p.imageUrl}
						className={cn("size-8", !here && "opacity-50")}
					/>
					<div className="min-w-0">
						<Link
							to="/products/$sku"
							params={{ sku: p.sku }}
							className={cn(
								"block hover:underline",
								!here && "text-muted-foreground",
							)}
						>
							<span className="line-clamp-2">
								{p.name}
								{p.variantName && (
									<span className="ml-1.5 rounded-md bg-surface px-1.5 text-xs text-muted-foreground">
										{p.variantName}
									</span>
								)}
							</span>
						</Link>
						<div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
							<span>
								{p.sku} · {formatCount(p.perSet)} per set
							</span>
							<PartSource part={p} state={state} sets={sets} />
							{/* Only this PO orders it, so only here can it be skipped. */}
							{(here || state.kind === "skipped") && (
								<Tip
									content={here ? "Skip for this set" : "Order for this set"}
								>
									<button
										type="button"
										disabled={busy}
										onClick={() => skip(here)}
										className="cursor-pointer font-medium text-foreground hover:underline disabled:opacity-50"
									>
										{here ? "Skip" : "Order it"}
									</button>
								</Tip>
							)}
						</div>
					</div>
				</div>
			</td>
			<td className="px-3 py-2 text-muted-foreground">
				{here ? (p.supplierSku ?? "—") : ""}
			</td>
			<td className="px-3 py-2">
				{here && <PurchaseUnitCell label={p.sku} value={p} cost={p.unitCost} />}
			</td>
			<Tip
				content={`${formatCount(p.perSet)} per set × ${formatCount(sets)} ${sets === 1 ? "set" : "sets"}`}
			>
				<td className="px-3 py-2 text-right font-semibold tabular-nums">
					{here ? (
						<span className="inline-block w-16 px-2">
							{formatCount(items)}
							{p.packSize > 1 && (
								<span className="ml-0.5 text-xs font-normal text-muted-foreground">
									ea
								</span>
							)}
						</span>
					) : (
						<span className="text-muted-foreground">—</span>
					)}
				</td>
			</Tip>
			<td className="px-3 py-2">
				{here ? (
					<AfterPo onHand={p.onHand} range={p.stockRange} ordered={ordered} />
				) : (
					<span className="block text-center text-muted-foreground">—</span>
				)}
			</td>
			<td className="px-3 py-2">
				{here ? (
					<VelocityGauge why={p.why} />
				) : (
					<span className="block text-center text-muted-foreground">—</span>
				)}
			</td>
			<td className="px-3 py-2 text-right whitespace-nowrap text-muted-foreground tabular-nums">
				{here && p.unitCost !== null ? formatMoney(p.unitCost) : "—"}
			</td>
			<td className="px-4 py-2 text-right whitespace-nowrap text-muted-foreground tabular-nums">
				{here && p.unitCost !== null
					? formatMoney((items / p.packSize) * p.unitCost)
					: "—"}
			</td>
		</tr>
	);
}

// Where a part of a set comes from, when it isn't this PO.
function PartSource({
	part: p,
	state,
	sets,
}: {
	part: SetPart;
	state: PartState;
	sets: number;
}) {
	const pos = p.elsewhere.map((e, i) => (
		<Fragment key={e.purchaseOrderId}>
			{i > 0 && ", "}
			<Link
				to="/purchasing/$id"
				params={{ id: String(e.purchaseOrderId) }}
				className="hover:text-foreground hover:underline"
			>
				PO {e.purchaseOrderId}
				{e.status === "sent" && " (sent)"}
			</Link>
		</Fragment>
	));
	switch (state.kind) {
		case "here":
			return null;
		case "skipped":
			return <span className="font-medium">Skipped</span>;
		case "covered":
			return (
				<span>
					From {p.supplierName} on {pos}
				</span>
			);
		case "short":
			return (
				<span className="flex items-center gap-1 text-warning-text">
					<AlertTriangle className="size-3.5 shrink-0" />
					{state.noSupplier ? (
						"No supplier; set one on its page"
					) : state.covered === 0 ? (
						`Not on ${p.supplierName}'s PO`
					) : (
						<span>
							{p.supplierName}'s {pos}{" "}
							{p.elsewhere.length === 1 ? "has" : "have"}{" "}
							{formatCount(state.covered)} of {formatCount(sets)} sets
						</span>
					)}
				</span>
			);
	}
}

// Puts a set on the drafts of the other suppliers its parts come from, so
// each part is ordered for every set. Shows only while one isn't.
export function AddSetButton({
	line,
	parts,
	sets,
	supplierId,
	disabled,
}: {
	line: Line;
	parts: SetPart[];
	sets: number;
	supplierId: number;
	disabled: boolean;
}) {
	const { busy, run } = useAction();
	const short = shortBySupplier(parts, sets, supplierId);
	if (short.size === 0) return null;
	const names = [...short.keys()].map(
		(id) => parts.find((p) => p.supplierId === id)?.supplierName ?? "",
	);
	return (
		<Tip
			content={`Add ${formatCount(sets)} to ${names.join(" and ")}'s ${names.length === 1 ? "draft" : "drafts"}`}
		>
			<Button
				size="sm"
				variant="outline"
				className="h-6 px-2 text-xs"
				disabled={busy || disabled}
				onClick={() =>
					run(
						() => addSetToOtherPos({ data: { lineId: ids.server(line.id) } }),
						(added) =>
							added
								.map(
									(a) =>
										`PO ${a.purchaseOrderId} (${a.supplierName}) has ${formatCount(a.sets)} of ${line.sku}`,
								)
								.join("; "),
					)
				}
			>
				{names.length === 1
					? `Add to ${names[0]}'s PO`
					: `Add to ${names.length} other POs`}
			</Button>
		</Tip>
	);
}
