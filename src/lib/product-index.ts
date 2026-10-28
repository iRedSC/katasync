import { type QueryClient, useQuery } from "@tanstack/react-query";
import { listProductIndex } from "#/server/catalog";

export type IndexedProduct = Awaited<
	ReturnType<typeof listProductIndex>
>[number];

// Every carried product, for the pickers and the palette. One shared query,
// so they all see the same list and one load serves them.
const KEY = ["product-index"] as const;

// What a picker shows: the list, a wait, or a failure it can retry. A load
// that failed is never kept; the next ask, or Retry, loads again.
export type ProductIndex =
	| { status: "loading" }
	| { status: "failed"; message: string; retry: () => void }
	| { status: "ready"; products: IndexedProduct[] };

export function indexState(query: {
	data: IndexedProduct[] | undefined;
	error: unknown;
	isFetching: boolean;
	refetch: () => unknown;
}): ProductIndex {
	// A refresh that failed still has the last list to search.
	if (query.data) return { status: "ready", products: query.data };
	if (query.error && !query.isFetching)
		return {
			status: "failed",
			message:
				query.error instanceof Error
					? query.error.message
					: String(query.error),
			retry: () => void query.refetch(),
		};
	return { status: "loading" };
}

// `enabled` holds the load until the list is wanted.
export function useProductIndex(enabled = true): ProductIndex {
	return indexState(
		useQuery({
			queryKey: KEY,
			queryFn: () => listProductIndex(),
			enabled,
			// Changes elsewhere mark it stale (see invalidateProductIndex); this
			// only spares a reload each time a picker opens.
			staleTime: 60_000,
		}),
	);
}

// The list is out of date: a product was made, archived, restored, or
// edited, or listings were pulled. Whatever shows it loads it again.
export function invalidateProductIndex(queryClient: QueryClient) {
	return queryClient.invalidateQueries({ queryKey: KEY });
}
