import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	index,
	integer,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

// `owned` locations are ours to pick from. `fba` stock is Amazon's: we only
// mirror what Amazon reports and never route orders to it.
export const locationKind = pgEnum("location_kind", ["owned", "fba"]);

export const locations = pgTable("locations", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	name: text().notNull().unique(),
	kind: locationKind().notNull(),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// simple: a stocked item.
// kit: pre-assembled from simple components; has its own stock.
// bundle: virtual; no stock of its own, availability comes from components.
export const skuKind = pgEnum("sku_kind", ["simple", "kit", "bundle"]);

export const skus = pgTable("skus", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	sku: text().notNull().unique(),
	name: text().notNull(),
	kind: skuKind().notNull(),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// Recipe for kits and bundles. Which kinds may contain which is enforced in
// src/inventory/recipes.ts.
export const skuComponents = pgTable(
	"sku_components",
	{
		parentSkuId: integer()
			.notNull()
			.references(() => skus.id),
		componentSkuId: integer()
			.notNull()
			.references(() => skus.id),
		quantity: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.parentSkuId, t.componentSkuId] }),
		check("sku_components_quantity_positive", sql`${t.quantity} > 0`),
		check(
			"sku_components_not_self",
			sql`${t.parentSkuId} <> ${t.componentSkuId}`,
		),
	],
);

export const movementReason = pgEnum("movement_reason", [
	"receipt",
	"sale",
	"return",
	"adjustment",
	"transfer_out",
	"transfer_in",
	"assembly_consume",
	"assembly_produce",
]);

// Append-only. A trigger in the migrations rejects UPDATE and DELETE; fix
// mistakes with a compensating movement. Only src/inventory/ledger.ts writes here.
export const movements = pgTable(
	"movements",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		// Groups the lines of one operation, e.g. every line of an assembly.
		batchId: uuid().notNull(),
		skuId: integer()
			.notNull()
			.references(() => skus.id),
		locationId: integer()
			.notNull()
			.references(() => locations.id),
		delta: integer().notNull(),
		reason: movementReason().notNull(),
		// Order, PO, or transfer this came from.
		reference: text(),
		note: text(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		check("movements_delta_nonzero", sql`${t.delta} <> 0`),
		index("movements_sku_location_idx").on(t.skuId, t.locationId),
		index("movements_created_at_idx").on(t.createdAt),
	],
);

// Running balance of movements per SKU and location, kept in step by
// src/inventory/ledger.ts in the same transaction. onHand may go negative:
// channels can sell stock we don't have, and the sale still has to be recorded.
export const stockLevels = pgTable(
	"stock_levels",
	{
		skuId: integer()
			.notNull()
			.references(() => skus.id),
		locationId: integer()
			.notNull()
			.references(() => locations.id),
		onHand: integer().notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.skuId, t.locationId] })],
);
