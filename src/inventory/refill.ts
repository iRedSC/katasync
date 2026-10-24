import { and, eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { products, shelfTargets } from "#/db/schema";
import { lockDraft, setTransferLines, TransferError } from "./transfers";

// A location's target for a product: refills top it back up to this. null
// stops refilling it there.
export async function setShelfTarget(
	db: Db,
	input: { productId: number; locationId: number; target: number | null },
) {
	if (input.target === null || input.target === 0) {
		await db
			.delete(shelfTargets)
			.where(
				and(
					eq(shelfTargets.productId, input.productId),
					eq(shelfTargets.locationId, input.locationId),
				),
			);
		return;
	}
	if (!Number.isInteger(input.target) || input.target < 0)
		throw new TransferError("A target is a whole number from 0");
	const [product] = await db
		.select({ kind: products.kind, sku: products.sku })
		.from(products)
		.where(eq(products.id, input.productId));
	if (!product) throw new TransferError("No such product");
	if (product.kind === "bundle")
		throw new TransferError(
			`${product.sku} is a tool set; give its parts targets`,
		);
	await db
		.insert(shelfTargets)
		.values({ ...input, target: input.target })
		.onConflictDoUpdate({
			target: [shelfTargets.productId, shelfTargets.locationId],
			set: { target: input.target },
		});
}

export type RefillRow = {
	productId: number;
	sku: string;
	name: string;
	variantName: string | null;
	imageUrl: string | null;
	target: number;
	atDestination: number;
	inTransit: number;
	atSource: number;
	// What to send: what tops it up, as far as the source has it.
	suggested: number;
};

// Products below their target at `toLocationId`, and how many of each
// `fromLocationId` can send. One the source has none of is still listed,
// with 0 suggested, so the shortfall shows.
export async function refillSuggestions(
	db: Db,
	input: { fromLocationId: number; toLocationId: number },
): Promise<RefillRow[]> {
	const targets = await db
		.select({
			productId: products.id,
			sku: products.sku,
			name: products.name,
			variantName: products.variantName,
			imageUrl: products.imageUrl,
			target: shelfTargets.target,
			atDestination: sql<number>`coalesce((select s.on_hand from stock_levels s where s.product_id = ${products.id} and s.location_id = ${input.toLocationId}), 0)::int`,
			atSource: sql<number>`coalesce((select s.on_hand from stock_levels s where s.product_id = ${products.id} and s.location_id = ${input.fromLocationId}), 0)::int`,
			inTransit: sql<number>`coalesce((select sum(l.quantity - coalesce((
				select sum(rl.quantity) from transfer_receipt_lines rl
				join transfer_receipts r on r.id = rl.receipt_id
				where r.dispatch_id = d.id and rl.product_id = l.product_id
				and not exists (select 1 from movements u where u.reference = 'undo:' || r.batch_id::text)
			), 0)) from transfer_dispatch_lines l
			join transfer_dispatches d on d.id = l.dispatch_id
			join transfers t on t.id = d.transfer_id and t.batch_id = d.batch_id
			where t.to_location_id = ${input.toLocationId} and l.product_id = ${products.id}), 0)::int`,
		})
		.from(shelfTargets)
		.innerJoin(products, eq(products.id, shelfTargets.productId))
		.where(eq(shelfTargets.locationId, input.toLocationId))
		.orderBy(products.sku);
	return targets.flatMap((t) => {
		const { atDestination, atSource, inTransit } = t;
		const need = t.target - Math.max(0, atDestination) - inTransit;
		if (need <= 0) return [];
		return [
			{
				...t,
				atDestination,
				inTransit,
				atSource,
				suggested: Math.min(need, Math.max(0, atSource)),
			},
		];
	});
}

// Puts the refill suggestions on a draft: each product below its target
// gets what tops it up. Products already on the draft for other reasons
// stay. Returns how many lines it set and the products the source can't
// help with.
//
// The draft is locked before its direction is read, so the suggestions are
// for the direction the lines land in, even when a swap is racing this.
export async function fillFromSuggestions(db: Db, id: number) {
	return db.transaction(async (tx) => {
		const t = await lockDraft(tx, id);
		const rows = await refillSuggestions(tx, t);
		const sending = rows.filter((r) => r.suggested > 0);
		await setTransferLines(
			tx,
			id,
			sending.map((r) => ({ productId: r.productId, quantity: r.suggested })),
		);
		return {
			filled: sending.length,
			none: rows.filter((r) => r.suggested === 0).map((r) => r.sku),
		};
	});
}
