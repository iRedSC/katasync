// A long list shows its first rows and grows by a page at a time, so every
// row is reachable and none is cut off silently.
export const PAGE = 300;

export function windowRows<T>(rows: readonly T[], limit: number) {
	return {
		shown: rows.slice(0, limit),
		hidden: Math.max(0, rows.length - limit),
	};
}

// The limit after asking for more: a page further, or all of them.
export const grow = (limit: number, all: number, everything: boolean) =>
	everything ? Math.max(limit, all) : limit + PAGE;
