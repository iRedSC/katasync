import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
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
		// When someone last counted this shelf, even if the count matched and
		// nothing moved. Null means never. Drives the cycle count list.
		lastCountedAt: timestamp({ withTimezone: true }),
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
export const stores = pgTable(
	"stores",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		channel: channel().notNull(),
		name: text().notNull().unique(),
		// The store whose listings become products when no product has their
		// SKU yet. Other stores' listings only match. At most one.
		primary: boolean().notNull().default(false),
		// Orders placed at or after this time take stock from the ledger. Earlier
		// orders are kept for history only, because the opening balances already
		// reflect them. Null means this store's orders never move stock.
		stockFrom: timestamp({ withTimezone: true }),
		// Sync resumes from the newest order update seen so far.
		ordersSyncedThrough: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("stores_one_primary").on(t.primary).where(sql`${t.primary}`),
	],
);

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
		// What the channel files the listing under, for filtering products.
		// Shopify sets these per product, so every variant repeats them; other
		// channels leave them empty. Status is Shopify's ACTIVE, DRAFT, or
		// ARCHIVED.
		tags: text().array().notNull().default(sql`'{}'::text[]`),
		productType: text(),
		vendor: text(),
		status: text(),
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

// A company we buy from. `code` is the short name Sumtracker used, e.g. "CANAM".
export const suppliers = pgTable("suppliers", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	code: text().notNull().unique(),
	name: text().notNull(),
	contactName: text(),
	// Where POs are emailed.
	email: text(),
	phone: text(),
	address1: text(),
	address2: text(),
	city: text(),
	region: text(),
	postalCode: text(),
	country: text(),
	paymentTerms: text(),
	// For us only, e.g. "Free shipping over $1500".
	notes: text(),
	// Printed on every PO sent to them.
	poNotes: text(),
	// Days from sending a PO to it arriving. Stock is reordered early enough to
	// last that long.
	leadTimeDays: integer().notNull().default(14),
	// Days of sales each PO should cover once it arrives. Longer means bigger,
	// rarer orders.
	coverDays: integer().notNull().default(30),
	// Spend threshold: a suggested PO counts as ready once its total reaches
	// this, e.g. their free-shipping minimum. 0 means ready as soon as anything
	// needs ordering.
	minimumOrder: numeric({ precision: 12, scale: 2, mode: "number" })
		.notNull()
		.default(0),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// Who we buy a product from. One supplier per product, so the product is the
// key. Bundles have no stock to buy; src/purchasing/suppliers.ts refuses them.
export const productSuppliers = pgTable(
	"product_suppliers",
	{
		productId: integer()
			.primaryKey()
			.references(() => products.id),
		supplierId: integer()
			.notNull()
			.references(() => suppliers.id),
		// The supplier's own part number, printed on POs next to ours.
		supplierSku: text(),
		// What the supplier charges per unit, USD. Starts each PO line; receiving
		// updates it to the last price paid.
		cost: numeric({ precision: 12, scale: 4, mode: "number" }),
		// Smallest quantity they'll sell, e.g. a case of 30.
		minimumQuantity: integer().notNull().default(1),
	},
	(t) => [
		index("product_suppliers_supplier_idx").on(t.supplierId),
		check("product_suppliers_minimum_positive", sql`${t.minimumQuantity} > 0`),
	],
);

// draft: still being edited; not on order yet.
// sent: emailed to the supplier. Stays sent while partly received.
// closed: everything arrived, or we stopped waiting for the rest.
// cancelled: never sent, or sent and called off before anything arrived.
export const purchaseOrderStatus = pgEnum("purchase_order_status", [
	"draft",
	"sent",
	"closed",
	"cancelled",
]);

// Shown as "PO 1001". Rules live in src/purchasing/orders.ts.
export const purchaseOrders = pgTable(
	"purchase_orders",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity({ startWith: 1001 }),
		supplierId: integer()
			.notNull()
			.references(() => suppliers.id),
		status: purchaseOrderStatus().notNull().default("draft"),
		// Where it's delivered and received into.
		locationId: integer()
			.notNull()
			.references(() => locations.id),
		// Printed on this PO, under the supplier's standing PO notes.
		notes: text(),
		sentAt: timestamp({ withTimezone: true }),
		// The address it was emailed to, in case the supplier's email changes.
		sentTo: text(),
		// When we expect it: sent date plus the supplier's lead time.
		expectedAt: timestamp({ withTimezone: true }),
		closedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("purchase_orders_supplier_idx").on(t.supplierId),
		// One draft per supplier, so suggestions have one place to go.
		uniqueIndex("purchase_orders_one_draft")
			.on(t.supplierId)
			.where(sql`${t.status} = 'draft'`),
	],
);

export const purchaseOrderLines = pgTable(
	"purchase_order_lines",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		purchaseOrderId: integer()
			.notNull()
			.references(() => purchaseOrders.id),
		productId: integer()
			.notNull()
			.references(() => products.id),
		quantity: integer().notNull(),
		// USD per unit. Null when nobody knows the price yet.
		unitCost: numeric({ precision: 12, scale: 4, mode: "number" }),
	},
	(t) => [
		unique("purchase_order_lines_product").on(t.purchaseOrderId, t.productId),
		check("purchase_order_lines_quantity_positive", sql`${t.quantity} > 0`),
	],
);

// Each time units of a line are received, and each undo (a negative quantity
// pointing at the receipt it reverses). A line's received count is the sum.
// batchId is the ledger batch that put the units on the shelf.
export const purchaseOrderReceipts = pgTable(
	"purchase_order_receipts",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		lineId: integer()
			.notNull()
			.references(() => purchaseOrderLines.id),
		quantity: integer().notNull(),
		batchId: uuid().notNull().unique(),
		// Set on an undo row: the receipt it reverses. Unique, so a receipt can
		// only be undone once.
		undoesId: integer()
			.unique()
			.references((): AnyPgColumn => purchaseOrderReceipts.id),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("purchase_order_receipts_line_idx").on(t.lineId),
		check("purchase_order_receipts_quantity_nonzero", sql`${t.quantity} <> 0`),
		check(
			"purchase_order_receipts_undo_is_negative",
			sql`(${t.undoesId} is null) = (${t.quantity} > 0)`,
		),
	],
);

// Saved product searches, shown as tabs on the products page. Shared by
// everyone, since the team signs in as one account. `filters` holds search
// chips (src/products/search.ts Filter[]); `sort` is a src/products/views.ts Sort.
export const productViews = pgTable("product_views", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	name: text().notNull().unique(),
	filters: jsonb().notNull(),
	sort: text().notNull().default("name"),
	position: integer().notNull().default(0),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
