import { waitUntil } from "@vercel/functions";
import type { Db } from "#/db/client";
import { setRetailReserve } from "#/inventory/online-stock";
import { pushRetailShelf } from "./on-change";

// Sets how many the retail store keeps for walk-ins, then pushes what that
// changes on the channels after the response, as a stock move would.
export async function changeRetailReserve(db: Db, units: number) {
	await setRetailReserve(db, units);
	waitUntil(
		pushRetailShelf(db)
			.then((pushed) => {
				for (const p of pushed)
					for (const problem of p.problems) console.warn(problem);
			})
			.catch((error) =>
				console.error("Stock push after the retail reserve changed:", error),
			),
	);
}
