import { useCallback, useState } from "react";

// The products ticked on the list. Kept outside React so it outlives the
// list remounting (a new search history entry, opening a product and coming
// back), but not a reload.
let kept: ReadonlySet<number> = new Set();

export function useSelection() {
	const [selected, setState] = useState(kept);
	const setSelected = useCallback((next: ReadonlySet<number>) => {
		kept = next;
		setState(next);
	}, []);
	return [selected, setSelected] as const;
}

// The rows that were ticked when the list last changed (a search, a sort, a
// view). They sit in a group at the top instead of wherever, or nowhere, the
// new list would put them. Rows ticked since stay where they are, so a tick
// never moves a row out from under the pointer.
export function usePinned(listKey: string, selected: ReadonlySet<number>) {
	const [pin, setPin] = useState(() => ({ key: listKey, ids: selected }));
	if (pin.key === listKey) return pin.ids;
	setPin({ key: listKey, ids: selected });
	return selected;
}

export function toggled(set: ReadonlySet<number>, ids: number[], on: boolean) {
	const next = new Set(set);
	for (const id of ids) {
		if (on) next.add(id);
		else next.delete(id);
	}
	return next;
}
