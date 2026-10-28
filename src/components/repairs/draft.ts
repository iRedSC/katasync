import { useState } from "react";

// A field being typed into, over a value that can change under it (an edit
// from another screen, or the page reloading). While staff haven't typed, it
// is the value; once they have, their words stay, and are saved only if they
// still differ. A different record starts over.

export type Draft<T> = {
	identity: string | number;
	value: T;
	edited: boolean;
};

export const start = <T>(identity: string | number, incoming: T): Draft<T> => ({
	identity,
	value: incoming,
	edited: false,
});

// The draft as the value now stands: the same object when nothing changed.
export function follow<T>(
	draft: Draft<T>,
	identity: string | number,
	incoming: T,
	same: (a: T, b: T) => boolean = Object.is,
): Draft<T> {
	if (draft.identity !== identity) return start(identity, incoming);
	if (!draft.edited)
		return same(draft.value, incoming) ? draft : start(identity, incoming);
	// What was typed has become the value (it saved): not an edit on it now.
	return same(draft.value, incoming) ? start(identity, incoming) : draft;
}

export const typed = <T>(draft: Draft<T>, value: T): Draft<T> => ({
	...draft,
	value,
	edited: true,
});

// What to save when the field is left: the words typed, only when staff
// typed them and they differ from the value, so merely focusing a field
// never writes an old value over a newer one.
export function toSave<T>(
	draft: Draft<T>,
	incoming: T,
	same: (a: T, b: T) => boolean = Object.is,
): T | null {
	return draft.edited && !same(draft.value, incoming) ? draft.value : null;
}

export function useDraft<T>(
	incoming: T,
	identity: string | number,
	same: (a: T, b: T) => boolean = Object.is,
) {
	const [state, setState] = useState(() => start(identity, incoming));
	// Following the value is part of rendering, so a stale one never shows.
	const draft = follow(state, identity, incoming, same);
	if (draft !== state) setState(draft);
	return {
		value: draft.value,
		type: (value: T) => setState(typed(draft, value)),
		// Back to the value, dropping what was typed.
		revert: () => setState(start(identity, incoming)),
		save: () => toSave(draft, incoming, same),
	};
}
