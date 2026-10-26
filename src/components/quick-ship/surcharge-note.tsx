import { formatMoney } from "#/lib/format";
import { PanelSection } from "./info-panel";
import type { Quote } from "./types";

// The box sits just under one of the focused carrier's lines: a little
// bigger or heavier, as a carrier's measuring often finds it, costs a lot
// more. Measure again, or pick a service that doesn't jump.
export function SurchargeNote({ quote }: { quote: Quote }) {
	if (quote.nearSurcharge === null) return null;
	return (
		<PanelSection
			key={quote.id}
			tone="warning"
			title={`Close to a ${quote.carrier} surcharge`}
		>
			<p className="text-sm">
				An inch longer and a pound heavier costs{" "}
				<span className="font-semibold tabular-nums">
					+{formatMoney(quote.nearSurcharge)}
				</span>
				.
			</p>
		</PanelSection>
	);
}
