import { and, eq, isNotNull, isNull, not, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders } from "#/db/schema";
import { needsShipping } from "#/orders/to-ship";

// Gives every order still to ship a pin and frees the pins of orders that no
// longer need shipping. Pins are as short as possible (1-9 first, then
// 10-99, then 100-999) so most take one keystroke, and random within that
// length so two orders packed side by side don't differ by one. Safe to run any
// time; channels syncing at once take turns, and the database refuses a pin
// used twice.
export async function assignOrderPins(db: Db): Promise<number> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext('order_pins'))`);
		return assignInLock(tx);
	});
}

async function assignInLock(db: Db) {
	await db
		.update(orders)
		.set({ pin: null })
		.where(and(isNotNull(orders.pin), not(needsShipping)));

	const waiting = await db
		.select({ id: orders.id })
		.from(orders)
		.where(and(isNull(orders.pin), needsShipping));
	if (waiting.length === 0) return 0;

	const used = new Set(
		(
			await db
				.select({ pin: orders.pin })
				.from(orders)
				.where(isNotNull(orders.pin))
		).map((o) => o.pin),
	);
	const free = [
		[1, 9],
		[10, 99],
		[100, 999],
	].map(([low, high]) => {
		const pins = [];
		for (let pin = low; pin <= high; pin++) if (!used.has(pin)) pins.push(pin);
		return pins;
	});
	const left = free.reduce((n, pins) => n + pins.length, 0);
	if (left < waiting.length) {
		throw new Error(`Only ${left} pins left for ${waiting.length} orders`);
	}
	for (const order of waiting) {
		const shortest = free.find((pins) => pins.length > 0) as number[];
		const pick = Math.floor(Math.random() * shortest.length);
		const [pin] = shortest.splice(pick, 1);
		await db.update(orders).set({ pin }).where(eq(orders.id, order.id));
	}
	return waiting.length;
}
