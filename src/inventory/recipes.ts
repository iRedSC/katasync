import { and, eq, ne } from "drizzle-orm";
import type { Db } from "#/db/client";
import { movements, productComponents } from "#/db/schema";
import { LedgerError } from "./ledger";
import { lockRecipe } from "./ledger/post";

// What each kind may contain. Kits hold only simple SKUs; bundles may also hold
// kits. Nothing holds a bundle, so recipes are at most two levels deep and
// can't form cycles.
const allowedComponents = {
	kit: ["simple"],
	bundle: ["simple", "kit"],
} as const;

// Replaces the full recipe for a kit or bundle.
export async function setRecipe(
	db: Db,
	parentProductId: number,
	components: { productId: number; quantity: number }[],
) {
	return db.transaction(async (tx) => {
		const {
			parent,
			recipe,
			products: rows,
		} = await lockRecipe(
			tx,
			parentProductId,
			components.map((component) => component.productId),
		);
		if (parent.kind === "simple") {
			throw new LedgerError(
				`${parent.sku} is a simple SKU and can't have components`,
			);
		}
		if (components.length === 0) {
			throw new LedgerError(`${parent.sku} needs at least one component`);
		}

		const byId = new Map(rows.map((r) => [r.id, r]));
		const allowed: readonly string[] = allowedComponents[parent.kind];
		for (const c of components) {
			const child = byId.get(c.productId);
			if (!child)
				throw new LedgerError(`Unknown component product ${c.productId}`);
			if (child.archivedAt)
				throw new LedgerError(
					`${child.sku} is archived; restore it to use it as a part`,
				);
			if (!allowed.includes(child.kind)) {
				throw new LedgerError(
					`A ${parent.kind} can't contain a ${child.kind} (${parent.sku} → ${child.sku})`,
				);
			}
			if (!Number.isInteger(c.quantity) || c.quantity <= 0) {
				throw new LedgerError(
					`Quantity for ${child.sku} must be a positive integer`,
				);
			}
		}

		if (parent.kind === "kit" && !sameParts(recipe, components)) {
			const [stocked] = await tx
				.select({ productId: movements.productId })
				.from(movements)
				.where(
					and(eq(movements.productId, parentProductId), ne(movements.delta, 0)),
				)
				.limit(1);
			if (stocked)
				throw new LedgerError(
					`${parent.sku} has inventory history; create a new SKU for different parts`,
				);
		}

		await tx
			.delete(productComponents)
			.where(eq(productComponents.parentProductId, parentProductId));
		await tx.insert(productComponents).values(
			components.map((c) => ({
				parentProductId,
				componentProductId: c.productId,
				quantity: c.quantity,
			})),
		);
	});
}

function sameParts(
	current: { productId: number; quantity: number }[],
	next: { productId: number; quantity: number }[],
) {
	const before = new Map(current.map((c) => [c.productId, c.quantity]));
	return (
		before.size === next.length &&
		next.every((c) => before.get(c.productId) === c.quantity)
	);
}
