import { and, eq, isNotNull, isNull, not, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders } from "#/db/schema";
import { needsShipping } from "#/orders/to-ship";

// Gives every order still to ship a 3-digit pin and frees the pins of orders
// that no longer need shipping. Pins are random rather than sequential, so
// two orders packed side by side don't differ by one digit. Safe to run any
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
	const free = [];
	for (let pin = 100; pin <= 999; pin++) if (!used.has(pin)) free.push(pin);
	if (free.length < waiting.length) {
		throw new Error(
			`Only ${free.length} pins left for ${waiting.length} orders`,
		);
	}
	for (const order of waiting) {
		const pick = Math.floor(Math.random() * free.length);
		const [pin] = free.splice(pick, 1);
		await db.update(orders).set({ pin }).where(eq(orders.id, order.id));
	}
	return waiting.length;
}
