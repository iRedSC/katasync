// Conversations taken off a list the moment staff mark them done (or reopen
// them), before the server's list catches up. Each is hidden only from the
// list it was taken off, so the same conversation still shows in the other
// one, and is let go once the server's list no longer has it.

export type ThreadView = "open" | "done";
export type Hidden = ReadonlyMap<number, ThreadView>;

export const noneHidden: Hidden = new Map();

export const hide = (hidden: Hidden, id: number, from: ThreadView): Hidden =>
	new Map(hidden).set(id, from);

export const unhide = (hidden: Hidden, id: number): Hidden => {
	if (!hidden.has(id)) return hidden;
	const next = new Map(hidden);
	next.delete(id);
	return next;
};

// What the list in this view shows.
export const visible = <T extends { id: number }>(
	threads: T[],
	hidden: Hidden,
	view: ThreadView,
) => threads.filter((t) => hidden.get(t.id) !== view);

// Lets go of those hidden from this view that its list no longer has: the
// server has moved them, so hiding them is no longer needed. The same
// map back when none.
export function retire(
	hidden: Hidden,
	view: ThreadView,
	threads: { id: number }[],
): Hidden {
	const listed = new Set(threads.map((t) => t.id));
	let next: Map<number, ThreadView> | null = null;
	for (const [id, from] of hidden) {
		if (from !== view || listed.has(id)) continue;
		next ??= new Map(hidden);
		next.delete(id);
	}
	return next ?? hidden;
}
