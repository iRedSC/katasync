import { useEffect, useState } from "react";
import {
	type PurchaseOrderMatch,
	searchForPurchaseOrder,
} from "#/server/purchasing";

export type { PurchaseOrderMatch };

export type SearchState =
	| { state: "idle" }
	| { state: "searching"; query: string; results: PurchaseOrderMatch[] }
	| { state: "done"; query: string; results: PurchaseOrderMatch[] }
	| { state: "failed"; query: string; message: string };

// The results a pick may use: only a finished search for the text in the box
// now. Earlier results stay up, dimmed, while the next search runs.
export function pickable(search: SearchState, query: string) {
	return search.state === "done" && search.query === query.trim()
		? search.results
		: null;
}

// What the search says about the text in the box now. Results and failures
// for any other text are pending: nothing from them may show or be picked.
export type Remote =
	| { state: "off" }
	| { state: "pending" }
	| { state: "done"; results: PurchaseOrderMatch[] }
	| { state: "failed"; message: string };

export function remoteFor(search: SearchState, query: string): Remote {
	const q = query.trim();
	if (q === "") return { state: "off" };
	if (search.state === "idle" || search.query !== q)
		return { state: "pending" };
	if (search.state === "done")
		return { state: "done", results: search.results };
	if (search.state === "failed")
		return { state: "failed", message: search.message };
	return { state: "pending" };
}

// Searches products to add to a PO as someone types. Waits for a pause, and
// only the newest query's answer is kept, so a slow early reply can't
// replace a later one. The last results stay up while the next search runs.
// retry asks again for the same text, after a failure.
export function usePurchaseOrderSearch(purchaseOrderId: number, query: string) {
	const [search, setSearch] = useState<SearchState>({ state: "idle" });
	const [attempt, setAttempt] = useState(0);
	const q = query.trim();
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt is retry
	useEffect(() => {
		if (q === "") {
			setSearch({ state: "idle" });
			return;
		}
		let current = true;
		setSearch((s) => ({
			state: "searching",
			query: q,
			results: s.state === "idle" || s.state === "failed" ? [] : s.results,
		}));
		const timer = setTimeout(() => {
			searchForPurchaseOrder({ data: { purchaseOrderId, query: q } }).then(
				(results) => current && setSearch({ state: "done", query: q, results }),
				(err) =>
					current &&
					setSearch({
						state: "failed",
						query: q,
						message: err instanceof Error ? err.message : String(err),
					}),
			);
		}, 150);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [purchaseOrderId, q, attempt]);
	return { search, retry: () => setAttempt((n) => n + 1) };
}

// Why a product might be the wrong one to add, or null when it's fine.
export function matchWarning(
	m: PurchaseOrderMatch,
	sent: boolean,
): { text: string; blocks: boolean } | null {
	if (m.kind === "bundle" && sent)
		return { text: "Tool set: add the parts that came", blocks: true };
	if (m.kind === "bundle") return null;
	if (m.otherPos.length > 0)
		return {
			text:
				m.otherPos.length === 1
					? `On PO ${m.otherPos[0].purchaseOrderId}`
					: `On ${m.otherPos.length} other POs`,
			blocks: false,
		};
	if (!m.fromThisSupplier)
		return {
			text:
				m.supplierName === null
					? "Nobody sells it"
					: `Sold by ${m.supplierName}, not here`,
			blocks: false,
		};
	if (m.supplierName !== null && m.supplierId !== null && !m.cheapest)
		return { text: `Cheaper at ${m.supplierName}`, blocks: false };
	return null;
}
