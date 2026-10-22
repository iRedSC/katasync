import { createFileRoute, redirect } from "@tanstack/react-router";
import { RANGES, type RangeKey } from "#/orders/profit";

// The profit overview is the Analytics page now; old links and bookmarks
// land there with the range they asked for.
export const Route = createFileRoute("/profit/overview")({
	beforeLoad: ({ search }) => {
		const range = (search as { range?: unknown }).range;
		throw redirect({
			to: "/analytics",
			search:
				typeof range === "string" && Object.hasOwn(RANGES, range)
					? { range: range as RangeKey }
					: {},
			replace: true,
		});
	},
});
