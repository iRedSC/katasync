import type { Type } from "arktype";

// What a stock read found for one listing.
export type Found<T> =
	| { state: "ready"; target: T; shows: number | null }
	| { state: "unpushable"; reason: string };

export type StockChannel<T> = {
	// Its name in messages, e.g. "Shopify".
	name: string;
	target: Type<T>;
	// Every listing the channel can report a quantity for, keyed by the
	// listing's externalId. Listings it leaves out are treated as gone.
	read(): Promise<Map<string, Found<T>>>;
};

// Splits work into pieces of at most `size`, for APIs that cap a call.
export function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
}
