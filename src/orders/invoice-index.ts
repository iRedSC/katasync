import { groupBy } from "#/lib/group-by";
import { addressKey, whyNotTogether } from "#/shipping/dispatch";

type Order = Parameters<typeof whyNotTogether>[0][number];

// For each order to print, the other orders still to ship that can share its
// box, by name and pin. Orders are bucketed by address first, so each one only
// checks the orders at its own address.
export function sharingOrders<T extends Order & { pin: number | null }>(
	toShip: T[],
	pool: T[],
	live: { orderId: number }[],
) {
	const byAddress = groupBy(
		pool.filter((c) => addressKey(c) !== null),
		(c) => addressKey(c) ?? "",
	);
	const sharing = new Map<number, { name: string; pin: number | null }[]>();
	for (const o of toShip) {
		const key = addressKey(o);
		const others = (key === null ? [] : (byAddress.get(key) ?? [])).filter(
			(c) => c.id !== o.id && whyNotTogether([o, c], live) === null,
		);
		sharing.set(
			o.id,
			others.map((c) => ({ name: c.name, pin: c.pin })),
		);
	}
	return sharing;
}
