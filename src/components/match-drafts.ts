import { useSyncExternalStore } from "react";

// What was typed into a new product that didn't save, by the listings it was
// for. Kept here rather than in the picker, so it outlives the picker: the
// queue's last item drops off as it's created, taking the picker with it, and
// comes back with a new one if creating it fails.
export type Draft = { sku: string; name: string };

export function createDrafts() {
	const drafts = new Map<string, Draft>();
	const listeners = new Set<() => void>();
	const changed = () => {
		for (const l of listeners) l();
	};
	return {
		get: (key: string) => drafts.get(key) ?? null,
		// The draft for `key`, or none once it saved or staff went back.
		set(key: string, draft: Draft | null) {
			if (draft) drafts.set(key, draft);
			else if (!drafts.delete(key)) return;
			changed();
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

export const matchDrafts = createDrafts();

export function useMatchDraft(key: string) {
	return useSyncExternalStore(
		matchDrafts.subscribe,
		() => matchDrafts.get(key),
		() => null,
	);
}
