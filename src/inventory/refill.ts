import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { products, shelfTargets, stockLevels, transfers } from "#/db/schema";
import { setTransferLines, TransferError, transferName } from "./transfers";

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
		})
		.from(shelfTargets)
		.innerJoin(products, eq(products.id, shelfTargets.productId))
		.where(eq(shelfTargets.locationId, input.toLocationId))
		.orderBy(products.sku);
	if (targets.length === 0) return [];
	const levels = await db
		.select()
		.from(stockLevels)
		.where(
			and(
				inArray(
					stockLevels.productId,
					targets.map((t) => t.productId),
				),
				inArray(stockLevels.locationId, [
					input.fromLocationId,
					input.toLocationId,
				]),
			),
		);
	const at = (productId: number, locationId: number) =>
		levels.find((l) => l.productId === productId && l.locationId === locationId)
			?.onHand ?? 0;
	return targets.flatMap((t) => {
		const atDestination = at(t.productId, input.toLocationId);
		const atSource = at(t.productId, input.fromLocationId);
		const need = t.target - Math.max(0, atDestination);
		if (need <= 0) return [];
		return [
			{
				...t,
				atDestination,
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
export async function fillFromSuggestions(db: Db, id: number) {
	const [t] = await db.select().from(transfers).where(eq(transfers.id, id));
	if (!t) throw new TransferError(`No transfer ${transferName(id)}`);
	const rows = await refillSuggestions(db, t);
	const sending = rows.filter((r) => r.suggested > 0);
	await setTransferLines(
		db,
		id,
		sending.map((r) => ({ productId: r.productId, quantity: r.suggested })),
	);
	return {
		filled: sending.length,
		none: rows.filter((r) => r.suggested === 0).map((r) => r.sku),
	};
}
