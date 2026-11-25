import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { committedStock } from "#/db/quantity-schema";
import { productComponents, products, stockLevels } from "#/db/schema";
import { getRecipe, LedgerError, lockRecipe } from "./ledger/post";

// Whole sets. A tool set has no stock of its own: it sells as its parts.
// When the set itself comes in boxed, those boxes are stock of a kit tied to
// the set (products.wholeSetOfId), so they're received, counted, moved and
// valued like anything else on a shelf, and built from or taken apart into
// the set's parts like any kit.
//
// What makes it a whole set rather than just a kit:
// - The set can sell its boxes plus what its loose parts make
//   (getAvailability).
// - Every order for the set takes boxes first, as many as are free, and
//   loose parts for the rest (recordSale, settleLine). Which it took is
//   kept with the order, so the invoice says what to pick (wholeToPack) and
//   a return comes back the way it went out.
// - The boxes stay closed: they never count as stock of the parts.
// - The kit's parts follow the set's, and the set's can't change while any
//   box is on a shelf or promised, since those hold the old parts
//   (refitWholeSet).
//
// The tie lasts as long as both products do, so an order that took boxes
// can always be told from one that took parts.

type Part = { productId: number; quantity: number };

// Each tool set's whole kit, for the sets that have one.
export async function wholeSetsOf(
	db: Db,
	setIds: number[],
): Promise<Map<number, number>> {
	if (setIds.length === 0) return new Map();
	const rows = await db
		.select({ id: products.id, setId: products.wholeSetOfId })
		.from(products)
		.where(inArray(products.wholeSetOfId, setIds));
	return new Map(
		rows.flatMap((r) => (r.setId === null ? [] : [[r.setId, r.id] as const])),
	);
}

export async function wholeSetOf(db: Db, setId: number) {
	return (await wholeSetsOf(db, [setId])).get(setId) ?? null;
}

// How many whole sets of a tool set are on shelves anywhere, in transit
// included: what must be sold or taken apart before the set stops being one.
export async function wholeOnHand(db: Db, setId: number) {
	const kitId = await wholeSetOf(db, setId);
	if (kitId === null) return 0;
	const [row] = await db
		.select({
			units: sql<number>`coalesce(sum(${stockLevels.onHand}), 0)::int`,
		})
		.from(stockLevels)
		.where(eq(stockLevels.productId, kitId));
	return row?.units ?? 0;
}

// The set's whole kit, read again once the set is locked. The id read
// before locking (to lock the kit along with it) must still be it.
export async function lockedWholeSet(
	db: Db,
	setId: number,
	expected: number | null,
) {
	const now = await wholeSetOf(db, setId);
	if (now !== expected) throw new LedgerError("The recipe changed; try again");
	return now;
}

// A kit holds only single products, so a kit inside the set counts as what
// it's built from.
async function looseParts(
	db: Db,
	parts: Part[],
	kinds: Map<number, string>,
): Promise<Part[]> {
	const flat = new Map<number, number>();
	const add = (productId: number, quantity: number) =>
		flat.set(productId, (flat.get(productId) ?? 0) + quantity);
	for (const part of parts) {
		if (kinds.get(part.productId) !== "kit") {
			add(part.productId, part.quantity);
			continue;
		}
		for (const inner of await getRecipe(db, part.productId))
			add(inner.productId, inner.quantity * part.quantity);
	}
	return [...flat].map(([productId, quantity]) => ({ productId, quantity }));
}

async function freeSku(db: Db, setSku: string) {
	for (let n = 1; ; n++) {
		const sku = n === 1 ? `${setSku}-WHOLE` : `${setSku}-WHOLE-${n}`;
		const [taken] = await db
			.select({ id: products.id })
			.from(products)
			.where(sql`lower(${products.sku}) = lower(${sku})`);
		if (!taken) return sku;
	}
}

// Gives a tool set its whole kit, or returns the one it has. It starts with
// none on hand: count the boxes onto a shelf, or build them from parts
// already received.
export async function createWholeSet(db: Db, setId: number) {
	return db.transaction(async (tx) => {
		const {
			parent: set,
			recipe,
			products: locked,
		} = await lockRecipe(tx, setId);
		if (set.kind !== "bundle")
			throw new LedgerError(`${set.sku} isn't a tool set`);
		const [existing] = await tx
			.select({ id: products.id, sku: products.sku })
			.from(products)
			.where(eq(products.wholeSetOfId, set.id));
		if (existing) return existing;
		if (set.archivedAt)
			throw new LedgerError(`${set.sku} is archived; restore it first`);
		if (recipe.length === 0)
			throw new LedgerError(`${set.sku} has no parts yet`);
		const parts = await looseParts(
			tx,
			recipe,
			new Map(locked.map((p) => [p.id, p.kind])),
		);
		const [kit] = await tx
			.insert(products)
			.values({
				sku: await freeSku(tx, set.sku),
				name: `${set.name} (whole set)`,
				kind: "kit",
				wholeSetOfId: set.id,
				catalogId: set.catalogId,
				category: set.category,
				imageUrl: set.imageUrl,
				weightGrams: set.weightGrams,
				lengthMm: set.lengthMm,
				widthMm: set.widthMm,
				heightMm: set.heightMm,
				insureWhenShipped: set.insureWhenShipped,
				aerosol: set.aerosol,
			})
			.returning({ id: products.id, sku: products.sku });
		await tx.insert(productComponents).values(
			parts.map((p) => ({
				parentProductId: kit.id,
				componentProductId: p.productId,
				quantity: p.quantity,
			})),
		);
		return kit;
	});
}

// A set's parts are changing, so its whole kit's change with them. Refused
// while any box is on a shelf or promised: those hold the old parts. With
// none anywhere, nothing says what a box holds but the set. The caller
// holds the set, the kit and the new parts locked.
export async function refitWholeSet(
	db: Db,
	set: { sku: string },
	kitId: number,
	parts: Part[],
	kinds: Map<number, string>,
) {
	const shelves = await db
		.select({ onHand: stockLevels.onHand })
		.from(stockLevels)
		.where(and(eq(stockLevels.productId, kitId), ne(stockLevels.onHand, 0)));
	const [promised] = await db
		.select({ units: committedStock.units })
		.from(committedStock)
		.where(
			and(eq(committedStock.productId, kitId), ne(committedStock.units, 0)),
		);
	// Sold as an order synced and not shipped yet: off the shelf already, with
	// no reservation to show for it.
	const sold = (await db.execute(sql`
		select 1 from order_lines l
		join orders o on o.id = l.order_id
		join movements m on m.batch_id = l.sale_batch_id and m.reason = 'sale'
		where m.product_id = ${kitId} and o.cancelled_at is null
			and coalesce(l.shipped_quantity, 0) < l.quantity
			and not exists (select 1 from movements u where u.reference = 'undo:' || m.batch_id::text)
		limit 1
	`)) as unknown as { rows: unknown[] };
	if (shelves.length > 0 || promised || sold.rows.length > 0) {
		const boxes = shelves.reduce((n, s) => n + s.onHand, 0);
		throw new LedgerError(
			shelves.length > 0
				? `${boxes} whole ${set.sku} on hand hold the old parts; sell them or take them apart first`
				: `Whole ${set.sku} promised to orders hold the old parts; ship or cancel them first`,
		);
	}
	const next = await looseParts(db, parts, kinds);
	await db
		.delete(productComponents)
		.where(eq(productComponents.parentProductId, kitId));
	await db.insert(productComponents).values(
		next.map((p) => ({
			parentProductId: kitId,
			componentProductId: p.productId,
			quantity: p.quantity,
		})),
	);
}

// How many whole sets each order line still holds, for the invoice to say
// what to pick: keyed `${orderId}:${the line's external id}`, with the whole
// sets' SKU. A line holds them as a reservation, or, taking stock as it
// syncs, as the sale it recorded less what has shipped: what the channel
// says shipped, or what our own dispatches handed off when that's more (the
// channel's count can lag a handoff). Whole sets go out first either way.
export async function wholeToPack(db: Db, orderIds: number[]) {
	const held = new Map<string, { sku: string; units: number }>();
	if (orderIds.length === 0) return held;
	const ids = sql.join(
		orderIds.map((id) => sql`${id}`),
		sql`, `,
	);
	const result = (await db.execute(sql`
		select k.order_id, l.external_id, w.sku,
			sum(k.quantity - commitment_settled(k.id))::int as units
		from stock_commitments k
		join order_lines l on l.id = k.order_line_id
		join stock_commitment_parts p on p.commitment_id = k.id
		join products w on w.id = p.product_id and w.whole_set_of_id = k.product_id
		where k.order_id in (${ids})
		group by k.order_id, l.external_id, w.sku
		union all
		select l.order_id, l.external_id, w.sku,
			greatest(sum(-m.delta) - greatest(coalesce(l.shipped_quantity, 0), coalesce((
				select sum(d.quantity) from dispatch_lines d
				join dispatch_orders o on o.dispatch_id = d.dispatch_id and o.order_id = d.order_id
				where d.order_id = l.order_id and d.line_external_id = l.external_id
					and o.channel_sent_at is not null and o.reversed_at is null
			), 0)), 0)::int
		from order_lines l
		join movements m on m.batch_id = l.sale_batch_id and m.reason = 'sale'
		join products w on w.id = m.product_id and w.whole_set_of_id = l.product_id
		where l.order_id in (${ids})
			and not exists (select 1 from movements u where u.reference = 'undo:' || m.batch_id::text)
		group by l.id, l.order_id, l.external_id, w.sku, l.shipped_quantity
	`)) as unknown as {
		rows: {
			order_id: number;
			external_id: string;
			sku: string;
			units: number;
		}[];
	};
	for (const row of result.rows) {
		const units = Number(row.units);
		if (units > 0)
			held.set(`${Number(row.order_id)}:${row.external_id}`, {
				sku: row.sku,
				units,
			});
	}
	return held;
}
