import type { ReactNode } from "react";
import { RebillNote } from "./rebill-note";
import type { Quote, Step } from "./types";

// The info panel's sections for this step. It shows only with something
// in it, and keeps its place while you move through the step's choices.
export function stepNotes({
	step,
	rates,
	focused,
}: {
	step: Step;
	rates: Quote[] | null;
	// The service highlighted on the rates step.
	focused: Quote | null;
}): ReactNode[] {
	const notes: ReactNode[] = [];
	if (step === "rates" && rates?.some((r) => r.rebills.length > 0)) {
		const current =
			rates.find(
				(r) => r.carrier === focused?.carrier && r.service === focused.service,
			) ?? null;
		notes.push(<RebillNote key="rebills" quote={current} />);
	}
	return notes;
}
