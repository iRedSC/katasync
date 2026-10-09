import { eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { skuComponents, skus } from "#/db/schema";
import { LedgerError } from "./ledger";

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
	parentSkuId: number,
	components: { skuId: number; quantity: number }[],
) {
	return db.transaction(async (tx) => {
		const [parent] = await tx
			.select()
			.from(skus)
			.where(eq(skus.id, parentSkuId));
		if (!parent) throw new LedgerError(`Unknown SKU ${parentSkuId}`);
		if (parent.kind === "simple") {
			throw new LedgerError(
				`${parent.sku} is a simple SKU and can't have components`,
			);
		}
		if (components.length === 0) {
			throw new LedgerError(`${parent.sku} needs at least one component`);
		}

		const rows = await tx
			.select()
			.from(skus)
			.where(
				inArray(
					skus.id,
					components.map((c) => c.skuId),
				),
			);
		const byId = new Map(rows.map((r) => [r.id, r]));
		const allowed: readonly string[] = allowedComponents[parent.kind];
		for (const c of components) {
			const child = byId.get(c.skuId);
			if (!child) throw new LedgerError(`Unknown component SKU ${c.skuId}`);
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

		await tx
			.delete(skuComponents)
			.where(eq(skuComponents.parentSkuId, parentSkuId));
		await tx.insert(skuComponents).values(
			components.map((c) => ({
				parentSkuId,
				componentSkuId: c.skuId,
				quantity: c.quantity,
			})),
		);
	});
}
