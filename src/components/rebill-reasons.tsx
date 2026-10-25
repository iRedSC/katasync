import { inches, poundsOunces } from "#/components/quick-ship/units";
import { formatCount, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { LabelRebill } from "#/orders/postage-adjustments";
import type { Parcel } from "#/shipping/rebill-reason";

// Why Shippo re-billed a label, item by item. A charge correction sets the
// package as billed over the package as declared, what grew in red; a
// surcharge reads as Shippo named it.
export function RebillReasons({
	rebills,
	className,
}: {
	rebills: LabelRebill[];
	className?: string;
}) {
	if (rebills.length === 0) return null;
	const shared = Math.max(...rebills.map((r) => r.sharedWith));
	return (
		<div className={cn("flex flex-col gap-1 text-xs", className)}>
			<ul className="flex flex-col gap-1">
				{rebills.map((r, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: as Shippo billed them, never reordered
					<li key={i} className="flex items-start justify-between gap-3">
						{r.reason.kind === "correction" ? (
							<Correction
								billed={r.reason.billed}
								declared={r.reason.declared}
							/>
						) : (
							<span className="text-muted-foreground">{r.reason.text}</span>
						)}
						<span
							className={cn(
								"shrink-0 tabular-nums",
								r.amount > 0 && "text-critical-text",
							)}
						>
							{formatMoney(r.amount)}
						</span>
					</li>
				))}
			</ul>
			{shared > 0 && (
				<p className="text-muted-foreground">
					The whole label's, shared with {formatCount(shared)} other{" "}
					{shared === 1 ? "order" : "orders"}
				</p>
			)}
		</div>
	);
}

// Sides largest first, as carriers measure them.
const sides = (p: Parcel) => p.box.map(inches).sort((a, b) => b - a);

function Correction({
	billed,
	declared,
}: {
	billed: Parcel;
	declared: Parcel;
}) {
	const b = sides(billed);
	const d = sides(declared);
	const heavier =
		poundsOunces(billed.weightGrams) !== poundsOunces(declared.weightGrams) &&
		billed.weightGrams > declared.weightGrams;
	const grew = (v: number, was: number) =>
		v > was ? "font-medium text-critical-text" : undefined;
	return (
		<dl className="grid grid-cols-[auto_auto_auto] gap-x-3 tabular-nums">
			<dt className="text-muted-foreground">Billed as</dt>
			<dd className={heavier ? "font-medium text-critical-text" : undefined}>
				{poundsOunces(billed.weightGrams)}
			</dd>
			<dd>
				{b.map((v, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a box's three sides
					<span key={i}>
						{i > 0 && " × "}
						<span className={grew(v, d[i])}>{v}</span>
					</span>
				))}{" "}
				in
			</dd>
			<dt className="text-muted-foreground">Declared</dt>
			<dd className="text-muted-foreground">
				{poundsOunces(declared.weightGrams)}
			</dd>
			<dd className="text-muted-foreground">{d.join(" × ")} in</dd>
		</dl>
	);
}
