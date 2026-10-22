// The items under each key, each group in the order they came. One pass, so
// looking a group up is a map read, not a scan of every item.
export function groupBy<T, K>(items: readonly T[], key: (item: T) => K) {
	const groups = new Map<K, T[]>();
	for (const item of items) {
		const k = key(item);
		const group = groups.get(k);
		if (group) group.push(item);
		else groups.set(k, [item]);
	}
	return groups;
}
