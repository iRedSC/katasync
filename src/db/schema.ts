import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	numeric,
	pgEnum,
	pgTable,
	primaryKey,
	smallint,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

// `owned` locations are ours to pick from. `fba` stock is Amazon's: we only
// mirror what Amazon reports and never route orders to it.
export const locationKind = pgEnum("location_kind", ["owned", "fba"]);

export const locations = pgTable("locations", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	name: text().notNull().unique(),
	kind: locationKind().notNull(),
	// Ship-from address for labels, filled from the store's own location
	// record rather than typed in.
	shipFromName: text(),
	address1: text(),
	address2: text(),
	city: text(),
	region: text(),
	postalCode: text(),
	country: text(),
	phone: text(),
	// Carriers want an email on the sender; the store's contact email.
	email: text(),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// simple: a stocked item.
// kit: pre-assembled from simple components; has its own stock.
// bundle: virtual; no stock of its own, availability comes from components.
export const productKind = pgEnum("product_kind", ["simple", "kit", "bundle"]);

// A family of variants, e.g. one flat box in several sizes. Display only:
// stock, recipes, and listings all work on individual products.
export const productGroups = pgTable("product_groups", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	name: text().notNull().unique(),
	imageUrl: text(),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// The canonical record for one SKU. Listings on every channel map onto this.
export const products = pgTable(
	"products",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		sku: text().notNull().unique(),
		name: text().notNull(),
		kind: productKind().notNull(),
		groupId: integer().references(() => productGroups.id),
		// What sets this apart within its group, e.g. "12 x 9 x 2".
		variantName: text(),
		imageUrl: text(),
		// Free-form type for filtering and reports, e.g. "Flat Box".
		category: text(),
		// UPC/EAN. Unique so a scan finds exactly one product.
		barcode: text().unique(),
		// USD per unit, for PO totals and stock value.
		unitCost: numeric({ precision: 12, scale: 4, mode: "number" }),
		// Shipped weight and box size, for buying labels.
		weightGrams: integer(),
		// Always offer insurance when this ships, whatever the order's value.
		insureWhenShipped: boolean().notNull().default(false),
		lengthMm: integer(),
		widthMm: integer(),
		heightMm: integer(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("products_group_idx").on(t.groupId),
		check(
			"products_variant_needs_group",
			sql`${t.variantName} is null or ${t.groupId} is not null`,
		),
	],
);

// Other seller SKUs that mean this product, e.g. an FBA listing's
// "ECDT-12KIT-AMZ" for "ECDT-12KIT". Used to suggest listing mappings. An alias
// must not equal any product SKU; src/import/sumtracker.ts checks this.
export const productAliases = pgTable("product_aliases", {
	alias: text().primaryKey(),
	productId: integer()
		.notNull()
		.references(() => products.id),
});

// Recipe for kits and bundles. Which kinds may contain which is enforced in
// src/inventory/recipes.ts.
export const productComponents = pgTable(
	"product_components",
	{
		parentProductId: integer()
			.notNull()
			.references(() => products.id),
		componentProductId: integer()
			.notNull()
			.references(() => products.id),
		quantity: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.parentProductId, t.componentProductId] }),
		check("product_components_quantity_positive", sql`${t.quantity} > 0`),
		check(
			"product_components_not_self",
			sql`${t.parentProductId} <> ${t.componentProductId}`,
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
	// Starting stock carried over from another system.
	"opening_balance",
]);

// Append-only. A trigger in the migrations rejects UPDATE and DELETE; fix
// mistakes with a compensating movement. Only src/inventory/ledger.ts writes here.
export const movements = pgTable(
	"movements",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		// Groups the lines of one operation, e.g. every line of an assembly.
		batchId: uuid().notNull(),
		productId: integer()
			.notNull()
			.references(() => products.id),
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
		index("movements_product_location_idx").on(t.productId, t.locationId),
		index("movements_created_at_idx").on(t.createdAt),
	],
);

// Running balance of movements per SKU and location, kept in step by
// src/inventory/ledger.ts in the same transaction. onHand may go negative:
// channels can sell stock we don't have, and the sale still has to be recorded.
export const stockLevels = pgTable(
	"stock_levels",
	{
		productId: integer()
			.notNull()
			.references(() => products.id),
		locationId: integer()
			.notNull()
			.references(() => locations.id),
		onHand: integer().notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.productId, t.locationId] })],
);

export const channel = pgEnum("channel", [
	"shopify",
	"amazon",
	"ebay",
	"tiktok",
]);

// One connected seller account on a channel. A second Shopify store or another
// Amazon marketplace is another row.
export const stores = pgTable("stores", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	channel: channel().notNull(),
	name: text().notNull().unique(),
	// Orders placed at or after this time take stock from the ledger. Earlier
	// orders are kept for history only, because the opening balances already
	// reflect them. Null means this store's orders never move stock.
	stockFrom: timestamp({ withTimezone: true }),
	// Sync resumes from the newest order update seen so far.
	ordersSyncedThrough: timestamp({ withTimezone: true }),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// `fba` listings are stocked and shipped by Amazon; we never push their quantity.
export const listingFulfillment = pgEnum("listing_fulfillment", [
	"merchant",
	"fba",
]);

// A sellable thing on a channel, mapped to the one product it sells. Many
// listings may sell the same product. A multi-pack is a bundle product, not a
// quantity here.
// Mapping rules live in src/channels/listings.ts.
export const listings = pgTable(
	"listings",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		storeId: integer()
			.notNull()
			.references(() => stores.id),
		// The ID stock and orders use on the channel:
		//   shopify: variant ID
		//   amazon:  seller SKU
		//   ebay:    inventory SKU
		//   tiktok:  SKU ID
		externalId: text().notNull(),
		// The seller SKU shown on the channel, used to suggest mappings.
		externalSku: text(),
		title: text().notNull(),
		fulfillment: listingFulfillment().notNull().default("merchant"),
		// Null until someone maps it.
		productId: integer().references(() => products.id),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("listings_store_external_id").on(t.storeId, t.externalId),
		index("listings_product_idx").on(t.productId),
	],
);

// An order as the channel reports it. Money is in the store's currency.
export const orders = pgTable(
	"orders",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		storeId: integer()
			.notNull()
			.references(() => stores.id),
		externalId: text().notNull(),
		// What the channel shows people, e.g. "#5536".
		name: text().notNull(),
		// Where the sale happened when a store relays other channels, e.g. a
		// Shopify order placed on TikTok Shop or at the Point of Sale.
		salesChannel: text(),
		// The order's ID on the marketplace it was really placed on, when a store
		// relays it (TikTok's order ID on a Shopify order). Unique, so one sale
		// can't be saved twice from two sources; marketplace fees match on it.
		marketplaceOrderId: text().unique(),
		placedAt: timestamp({ withTimezone: true }).notNull(),
		cancelledAt: timestamp({ withTimezone: true }),
		// The channel's own wording, e.g. UNFULFILLED, PARTIALLY_FULFILLED.
		fulfillmentStatus: text().notNull(),
		// The marketplace ships it from its own stock (Amazon FBA); it never
		// takes ours.
		fulfilledByChannel: boolean().notNull().default(false),
		financialStatus: text(),
		customerName: text(),
		shipAddress1: text(),
		shipAddress2: text(),
		shipCity: text(),
		shipRegion: text(),
		shipPostalCode: text(),
		shipCountry: text(),
		shipPhone: text(),
		// A short number (1 to 999) to find the order while packing. Only orders
		// still to ship have one, so pins are reused once an order ships.
		pin: smallint(),
		total: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
		shippingCharged: numeric({ precision: 12, scale: 2, mode: "number" })
			.notNull()
			.default(0),
		sourceUpdatedAt: timestamp({ withTimezone: true }).notNull(),
		syncedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("orders_store_external_id").on(t.storeId, t.externalId),
		index("orders_placed_at_idx").on(t.placedAt),
		uniqueIndex("orders_pin_unique").on(t.pin).where(sql`${t.pin} is not null`),
		check("orders_pin_range", sql`${t.pin} between 1 and 999`),
	],
);

export const orderLines = pgTable(
	"order_lines",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		orderId: integer()
			.notNull()
			.references(() => orders.id),
		externalId: text().notNull(),
		// The listing's ID on the channel (Shopify: variant ID).
		listingExternalId: text(),
		// Null until the listing is mapped to a product.
		productId: integer().references(() => products.id),
		sku: text(),
		title: text().notNull(),
		quantity: integer().notNull(),
		// Price per unit after every discount.
		unitPrice: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
		// Cost per unit when the line first came in, so later cost changes don't
		// rewrite past profit. Null when any part has no cost.
		unitCost: numeric({ precision: 12, scale: 4, mode: "number" }),
		// The stock movement this line made, if any. Set once, so re-syncing never
		// takes stock twice; a cancellation reverses exactly this batch.
		saleBatchId: uuid(),
	},
	(t) => [
		unique("order_lines_order_external_id").on(t.orderId, t.externalId),
		index("order_lines_product_idx").on(t.productId),
	],
);

// A box we ship in, with its own short pin (1 to 999) for quick ship.
export const packages = pgTable(
	"packages",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		pin: smallint().notNull().unique(),
		name: text().notNull(),
		lengthMm: integer().notNull(),
		widthMm: integer().notNull(),
		heightMm: integer().notNull(),
		// The empty box, so a weight estimate can include it.
		weightGrams: integer().notNull().default(0),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [check("packages_pin_range", sql`${t.pin} between 1 and 999`)],
);

// A label bought for an order. Also what quick ship learns from: the weight
// the same items shipped at, and which service gets picked for a box.
export const shipments = pgTable(
	"shipments",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		orderId: integer()
			.notNull()
			.references(() => orders.id),
		packageId: integer().references(() => packages.id),
		// What was in the box, e.g. "HANDLE×1|KNIFE-5×2" (see contentsKey). The
		// next order with the same contents starts from this box and weight.
		contentsKey: text().notNull(),
		lengthMm: integer().notNull(),
		widthMm: integer().notNull(),
		heightMm: integer().notNull(),
		weightGrams: integer().notNull(),
		// "shippo" for now; Amazon and TikTok labels come later.
		provider: text().notNull(),
		carrier: text().notNull(),
		// The provider's service code, e.g. Shippo's "usps_ground_advantage".
		service: text().notNull(),
		serviceName: text().notNull(),
		cost: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
		insuredAmount: numeric({ precision: 12, scale: 2, mode: "number" }),
		trackingNumber: text(),
		trackingUrl: text(),
		labelUrl: text().notNull(),
		externalId: text().notNull().unique(),
		// Bought with a test key: a sample label that can't actually ship.
		test: boolean().notNull(),
		// Handing tracking to the marketplace the order came from. Sent: when
		// it got there, and the marketplace's id for that fulfillment (Shopify
		// needs it to cancel on void). Not sent: why, shown with a retry.
		channelSentAt: timestamp({ withTimezone: true }),
		channelFulfillmentId: text(),
		channelError: text(),
		// Voiding asks the provider for the postage back. Refunds can take
		// days (USPS); refundStatus is the provider's word on it.
		voidedAt: timestamp({ withTimezone: true }),
		refundStatus: text(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("shipments_order_idx").on(t.orderId),
		index("shipments_contents_idx").on(t.contentsKey, t.createdAt),
	],
);
