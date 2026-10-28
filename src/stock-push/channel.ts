import type { Type } from "arktype";

// What one channel must do for stock push. Each adapter keeps its own idea
// of where a listing's quantity lives (`T`); src/stock-push/push.ts stores it
// on the listing between reads and checks it with `target` before writing.

// What a stock read found for one listing.
export type Found<T> =
	| { state: "ready"; target: T; shows: number | null }
	// byDesign: the channel never lets this listing's stock be set (a variant
	// it doesn't track, an offer we don't ship), so it's skipped, not a problem.
	| { state: "unpushable"; reason: string; byDesign?: true };

export type StockWrite<T> = { externalId: string; target: T; quantity: number };

export type StockChannel<T> = {
	// Its name in messages, e.g. "Shopify".
	name: string;
	target: Type<T>;
	// Every listing the channel can report a quantity for, keyed by the
	// listing's externalId. Listings it leaves out are treated as gone.
	read(): Promise<Map<string, Found<T>>>;
	// Sets each quantity. Returns the error for each externalId that failed;
	// one left out was set.
	write(writes: StockWrite<T>[]): Promise<Map<string, string>>;
};

// Splits work into pieces of at most `size`, for APIs that cap a call.
export function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
}
