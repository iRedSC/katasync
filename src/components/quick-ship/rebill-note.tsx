import { formatDate, formatMoney } from "#/lib/format";
import { billedAs } from "#/shipping/billed-as";
import { PanelSection } from "./info-panel";
import type { Quote } from "./types";
import { GRAMS_PER_OUNCE, size } from "./units";

const pounds = (grams: number) =>
	`${Math.round((grams / GRAMS_PER_OUNCE / 16) * 10) / 10} lb`;

// Older ones add little once the pattern is clear.
const SHOWN = 4;

// The focused service's carrier billed more after shipping on boxes this
// size: each label, declared against what the carrier billed for, so the
// next one can be declared right or sent another way.
export function RebillNote({ quote }: { quote: Quote | null }) {
	if (!quote) return null;
	const { carrier, rebills } = quote;
	if (rebills.length === 0) {
		return (
			<PanelSection
				key={quote.id}
				title={`${carrier} hasn't adjusted this size`}
			/>
		);
	}
	const total = rebills.reduce((sum, r) => sum + r.amount, 0);
	return (
		<PanelSection
			key={quote.id}
			tone="critical"
			title={`${carrier} adjusted this size ${rebills.length === 1 ? "once" : `${rebills.length}×`}, +${formatMoney(total)}`}
		>
			<ul className="flex flex-col gap-3">
				{rebills.slice(0, SHOWN).map((r) => (
					<li
						key={r.shipmentId}
						className="flex flex-col gap-1 rounded-lg border bg-card p-3 text-sm"
					>
						<div className="flex justify-between gap-2 font-medium">
							<span>{formatDate(r.shippedAt)}</span>
							<span className="text-critical-text tabular-nums">
								+{formatMoney(r.amount)}
							</span>
						</div>
						<span className="text-muted-foreground">
							Declared {size(r)} in, {pounds(r.weightGrams)}
						</span>
						{r.lines.map((line, i) => {
							const billed = billedAs(line.description);
							return (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
									key={i}
									className="flex justify-between gap-2"
								>
									<span>
										{billed
											? `Billed ${billed.inches.join(" × ")} in${billed.pounds === null ? "" : `, ${billed.pounds} lb`}`
											: line.description}
									</span>
									<span className="tabular-nums text-muted-foreground">
										{formatMoney(line.amount)}
									</span>
								</div>
							);
						})}
					</li>
				))}
			</ul>
			{rebills.length > SHOWN && (
				<p className="text-sm text-muted-foreground">
					+{rebills.length - SHOWN} older
				</p>
			)}
		</PanelSection>
	);
}
