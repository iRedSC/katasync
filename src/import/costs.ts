// Sets products' costs from a cost list (sku, name, cost), as
// profit-margarine exports it. Sales already made keep the cost they took;
// only those that went out with none take one. A product the list gives no
// cost keeps its own. Tool sets are left without one of their own, since one
// always costs its parts.
import { type } from "arktype";
import { and, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orderLines, products } from "#/db/schema";
import { readCsv } from "#/import/sumtracker";
import { lockStockProducts } from "#/inventory/ledger/post";
import { setCost } from "#/inventory/valuation";

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
	// Products with a cost the list doesn't give them. They keep it, except
	// tool sets.
	clear: (Product & { from: number; bundle: boolean })[];
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
			if (p.unitCost !== null)
				clear.push({ ...product, from: p.unitCost, bundle: true });
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
		else if (p.unitCost !== null)
			clear.push({ ...product, from: p.unitCost, bundle: false });
	}

	const unknown = [...listed]
		.filter(([k, e]) => e.costs.size > 0 && !used.has(k))
		.map(([, e]) => e.sku);
	return { set, clear, unknown, warnings };
}

// One transaction: every cost changes, or none does. Each is set as by hand
// (src/inventory/valuation.ts): what's on the shelf is revalued, sales
// already made keep their cost, and sales that went out with none take the
// new one. A product the list doesn't cost keeps the one it has. Tool sets'
// own costs are cleared, since one always costs its parts.
export async function applyCostImport(db: Db, plan: CostPlan) {
	return db.transaction(async (tx) => {
		await lockStockProducts(tx, [
			...plan.set.map((cost) => cost.productId),
			...plan.clear.filter((cost) => cost.bundle).map((cost) => cost.productId),
		]);
		const unknownSales = () =>
			tx
				.select({ n: sql<number>`count(*)::int` })
				.from(orderLines)
				.where(
					and(isNotNull(orderLines.productId), isNull(orderLines.unitCost)),
				)
				.then(([r]) => r.n);
		const before = await unknownSales();
		// Dated even when unchanged: the list confirms it.
		for (const c of plan.set)
			await setCost(tx, {
				productId: c.productId,
				cost: c.to,
				note: "Cost list",
			});
		const bundles = plan.clear.filter((c) => c.bundle);
		for (const c of bundles)
			await setCost(tx, {
				productId: c.productId,
				cost: null,
				note: "Cost list",
			});
		return {
			costed: plan.set.length,
			cleared: bundles.length,
			kept: plan.clear.length - bundles.length,
			salesCosted: before - (await unknownSales()),
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
