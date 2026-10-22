// Replaces every product's cost from a cost list (sku, name, cost), as
// profit-margarine exports it, and re-costs every sale from the new costs.
// The list is the whole truth: a product it gives no cost loses the one it
// had, so profit shows it as unknown instead of trusting it. Tool sets are
// left without one of their own, since one always costs its parts.
import { type } from "arktype";
import { inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { products } from "#/db/schema";
import { chunks, readCsv } from "#/import/sumtracker";

const costRow = type({
	sku: "string",
	"cost?": "string",
	"+": "ignore",
});

type CatalogProduct = {
	id: number;
	sku: string;
	kind: "simple" | "kit" | "bundle";
	unitCost: number | null;
};

type Product = { productId: number; sku: string };

export type CostPlan = {
	// Every product the list costs, changed or not, so each gets dated.
	set: (Product & { from: number | null; to: number })[];
	// Products with a cost the list doesn't give them.
	clear: (Product & { from: number })[];
	// SKUs the list costs that match no product or alias here.
	unknown: string[];
	warnings: string[];
};

const key = (sku: string) => sku.trim().toLowerCase();

export function planCostImport(
	csv: string,
	catalog: CatalogProduct[],
	aliases: { alias: string; productId: number }[],
): CostPlan {
	const warnings: string[] = [];
	// The list repeats a SKU in other capitals, usually once with a cost and
	// once without. Two different costs for one SKU is a question, not a pick.
	const listed = new Map<string, { sku: string; costs: Set<number> }>();
	for (const row of readCsv(csv, costRow, "cost list")) {
		const raw = row.cost?.trim() ?? "";
		const entry = listed.get(key(row.sku)) ?? {
			sku: row.sku,
			costs: new Set(),
		};
		listed.set(key(row.sku), entry);
		if (raw === "") continue;
		const cost = Number(raw);
		if (!Number.isFinite(cost) || cost < 0)
			throw new Error(`${row.sku} costs "${raw}", which isn't a cost`);
		entry.costs.add(Math.round(cost * 10_000) / 10_000);
	}
	const costOf = (k: string) => {
		const entry = listed.get(k);
		if (!entry || entry.costs.size === 0) return null;
		if (entry.costs.size > 1) {
			warnings.push(
				`${entry.sku} has costs ${[...entry.costs].join(" and ")}; left without one`,
			);
			return null;
		}
		return [...entry.costs][0];
	};

	const aliasesOf = new Map<number, string[]>();
	for (const a of aliases)
		aliasesOf.set(a.productId, [
			...(aliasesOf.get(a.productId) ?? []),
			a.alias,
		]);

	// Every SKU here that the list could have meant.
	const used = new Set([
		...catalog.map((p) => key(p.sku)),
		...aliases.map((a) => key(a.alias)),
	]);
	const set: CostPlan["set"] = [];
	const clear: CostPlan["clear"] = [];
	for (const p of catalog) {
		const product = { productId: p.id, sku: p.sku };
		// A tool set's own cost is never used, so one left over only misleads.
		if (p.kind === "bundle") {
			if (p.unitCost !== null) clear.push({ ...product, from: p.unitCost });
			continue;
		}
		let cost = costOf(key(p.sku));
		// Its own SKU wins; an alias fills in only when that has no cost.
		for (const alias of aliasesOf.get(p.id) ?? []) {
			const viaAlias = costOf(key(alias));
			if (viaAlias === null) continue;
			if (cost === null) cost = viaAlias;
			else if (viaAlias !== cost)
				warnings.push(
					`${p.sku} costs ${cost} but its alias ${alias} costs ${viaAlias}; kept ${cost}`,
				);
		}
		if (cost !== null) set.push({ ...product, from: p.unitCost, to: cost });
		else if (p.unitCost !== null) clear.push({ ...product, from: p.unitCost });
	}

	const unknown = [...listed]
		.filter(([k, e]) => e.costs.size > 0 && !used.has(k))
		.map(([, e]) => e.sku);
	return { set, clear, unknown, warnings };
}

// One transaction: either every cost and every sale changes, or none does.
export async function applyCostImport(db: Db, plan: CostPlan) {
	return db.transaction(async (tx) => {
		// Dated even when unchanged: the list confirms it.
		const byCost = new Map<number, number[]>();
		for (const c of plan.set) {
			const ids = byCost.get(c.to);
			if (ids) ids.push(c.productId);
			else byCost.set(c.to, [c.productId]);
		}
		for (const [cost, ids] of byCost)
			for (const batch of chunks(ids, 1000))
				await tx
					.update(products)
					.set({ unitCost: cost, unitCostUpdatedAt: sql`now()` })
					.where(inArray(products.id, batch));
		for (const batch of chunks(plan.clear, 1000))
			await tx
				.update(products)
				.set({ unitCost: null })
				.where(
					inArray(
						products.id,
						batch.map((c) => c.productId),
					),
				);
		// Every sale takes its product's cost as it is now, as a new sale would
		// (costOf in src/orders/ingest.ts): a tool set the sum of its parts,
		// unknown if any part is.
		// Counted in SQL: only the count comes back, not every sale's id.
		const { rows } = (await tx.execute(sql`
			WITH recosted AS (
				UPDATE order_lines l SET unit_cost = c.cost
				FROM (
					SELECT p.id, CASE WHEN p.kind = 'bundle' THEN (
						SELECT CASE WHEN count(*) > 0 AND bool_and(cp.unit_cost IS NOT NULL)
							THEN sum(cp.unit_cost * pc.quantity) END
						FROM product_components pc
						JOIN products cp ON cp.id = pc.component_product_id
						WHERE pc.parent_product_id = p.id
					) ELSE p.unit_cost END AS cost
					FROM products p
				) c
				WHERE l.product_id = c.id AND l.unit_cost IS DISTINCT FROM c.cost
				RETURNING l.id
			)
			SELECT count(*)::int AS n FROM recosted
		`)) as unknown as { rows: { n: number }[] };
		return {
			costed: plan.set.length,
			cleared: plan.clear.length,
			salesRecosted: rows[0].n,
		};
	});
}

export async function costCatalog(db: Db) {
	const [catalog, aliases] = await Promise.all([
		db
			.select({
				id: products.id,
				sku: products.sku,
				kind: products.kind,
				unitCost: products.unitCost,
			})
			.from(products),
		db.query.productAliases.findMany(),
	]);
	return { catalog, aliases };
}
