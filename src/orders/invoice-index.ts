import { groupBy } from "#/lib/group-by";
import { boxKey, whyNotTogether } from "#/shipping/dispatch";

type Order = Parameters<typeof whyNotTogether>[0][number];

// For each order to print, the other orders still to ship that can share its
// box, by name and pin. Orders are bucketed by boxKey first, so each one only
// checks the orders that could share its box.
export function sharingOrders<T extends Order & { pin: number | null }>(
	toShip: T[],
	pool: T[],
	live: { orderId: number }[],
) {
	const byKey = groupBy(
		pool.filter((c) => boxKey(c) !== null),
		(c) => boxKey(c) ?? "",
	);
	const sharing = new Map<number, { name: string; pin: number | null }[]>();
	for (const o of toShip) {
		const key = boxKey(o);
		const others = (key === null ? [] : (byKey.get(key) ?? [])).filter(
			(c) => c.id !== o.id && whyNotTogether([o, c], live) === null,
		);
		sharing.set(
			o.id,
			others.map((c) => ({ name: c.name, pin: c.pin })),
		);
	}
	return sharing;
}
