// What a typed search shows and allows. Rows answer the query they were
// fetched for, so while a newer one runs they stay up for show but can't be
// picked: Enter then would add a row from the query before.
export type Answer<T> = { q: string; rows: T[] } | null;

export function searchView<T>(
	found: Answer<T>,
	q: string,
	failedQ: string | null,
) {
	const failed = failedQ === q;
	const stale = found?.q !== q;
	return {
		rows: failed ? [] : (found?.rows ?? []),
		// Rows dimmed and not pickable: they answer another query.
		stale,
		failed,
		searching: q !== "" && stale && !failed,
	};
}
