import { useState } from "react";

// A typed draft beside the saved value it started from. When the saved value
// changes from elsewhere (a reload, an undo, another product's page), the
// draft follows it only if nothing was typed over the old one, so a newer
// edit is never overwritten by an older save coming back.
export type Draft = { draft: string; shown: string };

export function followSaved(state: Draft, saved: string): Draft {
	if (saved === state.shown) return state;
	return {
		shown: saved,
		draft: state.draft === state.shown ? saved : state.draft,
	};
}

export function useDraft(saved: string) {
	const [state, setState] = useState<Draft>({ draft: saved, shown: saved });
	const current = followSaved(state, saved);
	if (current !== state) setState(current);
	return {
		draft: current.draft,
		setDraft: (draft: string) => setState({ ...current, draft }),
		// Typed over, and not yet what's saved.
		edited: current.draft !== saved,
	};
}
