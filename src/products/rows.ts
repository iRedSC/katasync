// What a product row offers the search box: values to filter on and values
// to sort on. Shared by the product list and a PO's Browse, so both read a
// product the same way.

import type { StockState } from "#/components/stock-card";
import {
	daysLeft,
	levelOf,
	nextStepOf,
	trustOf,
} from "#/inventory/stock-state";
import type { Facets } from "#/products/search";
import type { SortValue } from "#/products/sort";
import type { ProductSortKey } from "#/products/views";
import type { ProductRow } from "#/server/catalog";

// The number the Inventory column shows: what's on the shelf when oversold,
// otherwise what can be sold or built.
export function stock(p: ProductRow) {
	return (p.onHand ?? 0) < 0 ? (p.onHand ?? 0) : p.available;
}

// Trust, level, and next step, worked out once per product per load.
export function stateOf(p: ProductRow, now: Date): StockState {
	const input = {
		...p,
		hasSupplier: p.supplier !== null,
	};
	const trust = trustOf(input, now);
	return {
		trust,
		level: levelOf(input),
		step: nextStepOf(input, trust),
		daysLeft: daysLeft(p.onHand, p.dailyDemand),
	};
}

// What the search language can filter each product on. Status covers
// Shopify's (active, draft, archived), the stock level unless healthy, and
// whether it's a tool set or kit.
export function facetsOf(p: ProductRow, state: StockState): Facets {
	const title = p.variantName ? `${p.name} ${p.variantName}` : p.name;
	const status = p.status ? [p.status.toLowerCase()] : [];
	if (state.level !== "healthy") status.push(state.level);
	if (p.kind === "bundle") status.push("tool set");
	if (p.kind === "kit") status.push("kit");
	if (p.reorder) status.push("needs ordering");
	if (p.draft) status.push("on a draft");
	if (p.onOrder > 0) status.push("on order");
	if (!p.supplier && p.kind !== "bundle") status.push("no supplier");
	const trust =
		state.trust.kind === "counted"
			? ["counted"]
			: state.trust.requested
				? ["uncounted", "count requested"]
				: ["uncounted"];
	return {
		text: [p.sku, title, p.category ?? ""],
		title: [title],
		tag: p.tags,
		type: p.category ? [p.category] : [],
		vendor: p.vendor ? [p.vendor] : [],
		status,
		class: p.abc ? [p.abc] : [],
		supplier: p.supplier ? [p.supplier.name] : [],
		trust,
		inventory: stock(p),
		velocity: p.dailyDemand * 30,
	};
}

// What each sort column orders a product by. Null sorts last.
export function sortValuesOf(
	p: ProductRow,
	state: StockState,
): Record<ProductSortKey, SortValue> {
	return {
		name: p.variantName ? `${p.name} ${p.variantName}` : p.name,
		sku: p.sku,
		// 1 is the most value, so ascending is A first.
		class: p.abcRank,
		inventory: stock(p),
		onhand: p.onHand,
		available: p.available,
		onorder: p.onOrder,
		velocity: p.dailyDemand * 30,
		// In units, so a case of 30 outranks 2 each.
		reorder: p.reorder ? p.reorder.quantity * p.reorder.packSize : null,
		// Unsold products last, since they aren't running out.
		runout: state.daysLeft,
		min: p.range.min,
		max: p.range.max,
		cost: p.unitCost,
		worth: p.unitCost === null ? null : Math.max(0, stock(p)) * p.unitCost,
		// Never counted is the oldest count of all.
		counted: p.lastCountedAt?.getTime() ?? 0,
		type: p.category,
		vendor: p.vendor,
		supplier: p.supplier?.name ?? null,
	};
}
