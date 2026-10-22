import { eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { productComponents, products } from "#/db/schema";
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
	parentProductId: number,
	components: { productId: number; quantity: number }[],
) {
	return db.transaction(async (tx) => {
		// Locked first, so two replacements of one parent run one after the other
		// and the last one's whole list is what's left.
		const [parent] = await tx
			.select()
			.from(products)
			.where(eq(products.id, parentProductId))
			.for("update");
		if (!parent) throw new LedgerError(`Unknown product ${parentProductId}`);
		if (parent.kind === "simple") {
			throw new LedgerError(
				`${parent.sku} is a simple SKU and can't have components`,
			);
		}
		if (components.length === 0) {
			throw new LedgerError(`${parent.sku} needs at least one component`);
		}

		// Share-locked so a part can't be archived mid-change.
		const rows = await tx
			.select()
			.from(products)
			.where(
				inArray(
					products.id,
					components.map((c) => c.productId),
				),
			)
			.for("share");
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
