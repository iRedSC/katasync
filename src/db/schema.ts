import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	customType,
	date,
	foreignKey,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	pgView,
	primaryKey,
	smallint,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

// Raw bytes, for files kept in the database (label PDFs).
const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
	dataType: () => "bytea",
	// node-postgres returns a Buffer, PGlite (tests) a plain Uint8Array.
	fromDriver: (value) => Buffer.from(value),
});

// `owned` is the warehouse: orders ship from it. `retail` is our store: POS
// sales take its stock, and shipped orders take from it what the warehouse is
// out of (someone fetches it), so the channels sell both. `fba` stock is
// Amazon's: we only mirror what Amazon reports and never route orders to it.
export const locationKind = pgEnum("location_kind", ["owned", "fba", "retail"]);

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
		// When the cost was last set, to tell when it may have gone stale. A
		// trigger (drizzle/0077) sets it whenever the cost changes and clears it
		// with the cost; receiving a PO and editing the cost set it even when the
		// number stays the same. Null on a cost from before it was tracked.
		unitCostUpdatedAt: timestamp({ withTimezone: true }),
		// Shipped weight and box size, for buying labels.
		weightGrams: integer(),
		// Always offer insurance when this ships, whatever the order's value.
		insureWhenShipped: boolean().notNull().default(false),
		// An aerosol: quick ship starts its boxes as hazmat (see
		// shipping/hazmat.ts).
		aerosol: boolean().notNull().default(false),
		lengthMm: integer(),
		widthMm: integer(),
		heightMm: integer(),
		// How much we like to keep on our own shelves. Both or neither; neither
		// means the defaults in settings. Shown as the on hand ring on POs.
		minStock: integer(),
		maxStock: integer(),
		// Can't run out: one of these needing ordering counts toward its
		// supplier's criticalThreshold. A items count without this.
		critical: boolean().notNull().default(false),
		// Set while nobody has counted it yet and it sells without limit: stock
		// push sends every channel a large number (src/inventory/not-counted.ts)
		// and reordering, stock value, and stockout risk leave it out. Sales
		// still post to the ledger. Only a shelf count clears it, and nothing
		// sets it back.
		notCountedSince: timestamp({ withTimezone: true }),
		// Stock push shows 0 on every channel once this few or fewer can be
		// sold, so the last units aren't sold out from under a miscount.
		closeAt: integer(),
		// Set when it's no longer carried: left out of lists, pickers,
		// reordering, counting, and listing matching, its history kept. Only an
		// inert product is archived (src/products/archive.ts).
		archivedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("products_group_idx").on(t.groupId),
		// Order lines match a SKU in other capitals (resolveProduct), on every
		// sync pass for each line still without a product.
		index("products_sku_lower_idx").on(sql`lower(${t.sku})`),
		check("products_close_at_positive", sql`${t.closeAt} > 0`),
		// A tool set has no shelf to count; its parts carry the state.
		check(
			"products_bundle_never_uncounted",
			sql`${t.kind} <> 'bundle' or ${t.notCountedSince} is null`,
		),
		check(
			"products_variant_needs_group",
			sql`${t.variantName} is null or ${t.groupId} is not null`,
		),
		check(
			"products_cost_date_needs_cost",
			sql`${t.unitCostUpdatedAt} is null or ${t.unitCost} is not null`,
		),
		check(
			"products_stock_range",
			sql`(${t.minStock} is null and ${t.maxStock} is null) or (${t.minStock} is not null and ${t.maxStock} is not null and ${t.minStock} >= 0 and ${t.maxStock} > ${t.minStock})`,
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
	// Oversold stock written off as a receipt lands, so the shelf restarts
	// from 0. Always in the receipt's batch.
	"oversold_reset",
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
		// Every movement moves stock, except an opening balance of 0: that
		// records that the shelf was known to be empty, so a stock pull
		// (src/stock-push/pull.ts) doesn't take a channel's number over it.
		check(
			"movements_delta_nonzero",
			sql`${t.delta} <> 0 or ${t.reason} = 'opening_balance'`,
		),
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
		// nothing moved. Null means never.
		lastCountedAt: timestamp({ withTimezone: true }),
		// When someone asked for this shelf to be counted. It's on the cycle
		// count list until a count lands after it, so counting clears it and
		// undoing that count brings it back.
		countRequestedAt: timestamp({ withTimezone: true }),
	},
	(t) => [primaryKey({ columns: [t.productId, t.locationId] })],
);

// One row per count that changed stock, keyed by its movement batch. Undoing
// the batch puts previousCountedAt back on the shelf. A count that matched
// posts no movements, so there is nothing to undo and no row.
export const stockCounts = pgTable("stock_counts", {
	batchId: uuid().primaryKey(),
	productId: integer()
		.notNull()
		.references(() => products.id),
	locationId: integer()
		.notNull()
		.references(() => locations.id),
	// The same transaction time recordCount wrote to stock_levels.lastCountedAt.
	countedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	previousCountedAt: timestamp({ withTimezone: true }),
});

// A list of stock to move from one of our locations to another, e.g. a
// refill of the retail store. A draft can change freely; sending it moves
// every line at once, as one ledger batch (batchId), so undoing it moves it
// all back and returns it to a draft. Rules live in
// src/inventory/transfers.ts.
export const transferStatus = pgEnum("transfer_status", ["draft", "sent"]);

export const transfers = pgTable(
	"transfers",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		fromLocationId: integer()
			.notNull()
			.references(() => locations.id),
		toLocationId: integer()
			.notNull()
			.references(() => locations.id),
		status: transferStatus().notNull().default("draft"),
		note: text(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		sentAt: timestamp({ withTimezone: true }),
		batchId: uuid().unique(),
	},
	(t) => [
		check(
			"transfers_two_places",
			sql`${t.fromLocationId} <> ${t.toLocationId}`,
		),
		// Sent means it moved stock, and only then.
		check(
			"transfers_sent_moved",
			sql`(${t.status} = 'sent') = (${t.batchId} is not null and ${t.sentAt} is not null)`,
		),
		index("transfers_status_idx").on(t.status, t.createdAt),
	],
);

export const transferLines = pgTable(
	"transfer_lines",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		transferId: integer()
			.notNull()
			.references(() => transfers.id, { onDelete: "cascade" }),
		productId: integer()
			.notNull()
			.references(() => products.id),
		quantity: integer().notNull(),
	},
	(t) => [
		unique("transfer_lines_one_per_product").on(t.transferId, t.productId),
		check("transfer_lines_quantity", sql`${t.quantity} > 0`),
	],
);

// How many of a product a location should hold, for refills: a transfer's
// suggestions top the location back up to this from the warehouse.
export const shelfTargets = pgTable(
	"shelf_targets",
	{
		productId: integer()
			.notNull()
			.references(() => products.id),
		locationId: integer()
			.notNull()
			.references(() => locations.id),
		target: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.productId, t.locationId] }),
		check("shelf_targets_positive", sql`${t.target} > 0`),
	],
);

// Every shelf count, matched or not: what the system expected and what was
// on the shelf. stock_counts only holds counts that moved stock (to undo
// them); this keeps the clean ones too, so drift can be told from noise
// ("off 3 of the last 4 counts" rather than "off once"). batchId is the
// correcting movement batch, null when the count matched. Written only by
// recordCount in src/inventory/ledger.ts. Read through the count_history view,
// which also marks counts that were undone.
export const countLog = pgTable(
	"count_log",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		productId: integer()
			.notNull()
			.references(() => products.id),
		locationId: integer()
			.notNull()
			.references(() => locations.id),
		countedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		expected: integer().notNull(),
		counted: integer().notNull(),
		batchId: uuid().unique(),
	},
	(t) => [
		index("count_log_product_idx").on(t.productId, t.countedAt),
		// A batch is posted exactly when the count was off.
		check(
			"count_log_batch_when_off",
			sql`(${t.batchId} is null) = (${t.expected} = ${t.counted})`,
		),
	],
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
		// Whether katasync sets this store's listing quantities
		// (src/stock-push). Off until the store is moved over from Sumtracker,
		// so the two never fight over the same listings.
		pushStock: boolean().notNull().default(false),
		// When the channel's own quantities were last read back.
		stockReadAt: timestamp({ withTimezone: true }),
		// The last push pass that reached the channel, and why the latest one
		// didn't, if it didn't.
		stockPushedAt: timestamp({ withTimezone: true }),
		stockPushError: text(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("stores_one_primary").on(t.primary).where(sql`${t.primary}`),
	],
);

// What stock push knows about one listing, from the channel's last read:
//   ready:      where to write its quantity, what the channel shows (null
//               when unknown), and the last write's error, if it failed.
//   unpushable: the channel lists it but katasync can't set it, and why.
//   unreported: the last read didn't list it at all.
// Null until a stock read has looked for it, so a new listing gets read
// right away instead of waiting out the read interval. `target` is the
// channel's own shape, checked by its adapter (src/stock-push/channels).
export type ListingStockPush =
	| {
			state: "ready";
			target: unknown;
			shows: number | null;
			error: string | null;
	  }
	| { state: "unpushable"; reason: string }
	| { state: "unreported" };

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
		stockPush: jsonb().$type<ListingStockPush>(),
		// When a full pass of the channel's listings first left it out: it's
		// gone from the channel. Cleared if it comes back. Set only by
		// markGoneListings in src/channels/listings.ts.
		goneAt: timestamp({ withTimezone: true }),
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
		// Rung up at our retail store (Shopify POS): its stock comes off the
		// store's shelf rather than the warehouse's.
		soldInStore: boolean().notNull().default(false),
		financialStatus: text(),
		customerName: text(),
		shipAddress1: text(),
		shipAddress2: text(),
		shipCity: text(),
		shipRegion: text(),
		shipPostalCode: text(),
		shipCountry: text(),
		shipPhone: text(),
		// Someone said nothing is coming back (the buyer kept it, or it was
		// lost), so a refund's items are a cost at once and the order leaves
		// Returns. A return request opened after it still counts.
		noReturnAt: timestamp({ withTimezone: true }),
		// A short number (1 to 999) to find the order while packing. Only orders
		// still to ship have one, so pins are reused once an order ships.
		pin: smallint(),
		// The last time its invoice went to the printer. Print all skips
		// orders that have one; ticking an order prints it again.
		invoicePrintedAt: timestamp({ withTimezone: true }),
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
		// rewrite past profit. Null when any part had no cost; profit then uses
		// the product's cost as it is now (order_line_costs).
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

// Units a customer sent back, received against the line they were sold on.
// Restocked units went back on the shelf through the movement in batchId;
// the rest were written off as damaged and moved nothing. Undoing a return
// reverses its batch and deletes the row. Rules live in src/orders/returns.ts.
export const orderReturns = pgTable(
	"order_returns",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		orderLineId: integer()
			.notNull()
			.references(() => orderLines.id),
		quantity: integer().notNull(),
		restocked: boolean().notNull(),
		batchId: uuid(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		check("order_returns_quantity_positive", sql`${t.quantity} > 0`),
		check(
			"order_returns_restocked_has_batch",
			sql`${t.restocked} = (${t.batchId} is not null)`,
		),
		index("order_returns_line_idx").on(t.orderLineId),
	],
);

// Where a return a buyer opened on a marketplace stands. Delivered means
// the carrier says it reached us; it's still due until it's received here.
export const returnRequestStatus = pgEnum("return_request_status", [
	"requested",
	"shipped",
	"delivered",
	"closed",
	"cancelled",
]);

// A return a buyer opened on the marketplace the order was billed by, as it
// last reported it. What's due back is worked out from these and refunds in
// the order_returns_due view (drizzle/0061_returns_tab.sql).
export const returnRequests = pgTable(
	"return_requests",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		orderId: integer()
			.notNull()
			.references(() => orders.id),
		billedBy: channel().notNull(),
		externalId: text().notNull(),
		status: returnRequestStatus().notNull(),
		// The marketplace's own wording.
		rawStatus: text().notNull(),
		// Why, as the marketplace names it (a code or its words).
		reason: text(),
		// What the buyer wrote about it, when they wrote anything.
		note: text(),
		trackingNumber: text(),
		carrier: text(),
		requestedAt: timestamp({ withTimezone: true }).notNull(),
		sourceUpdatedAt: timestamp({ withTimezone: true }).notNull(),
		syncedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("return_requests_billed_by_external_id").on(
			t.billedBy,
			t.externalId,
		),
		index("return_requests_order_idx").on(t.orderId),
	],
);

// What a return request says is coming back. orderLineId is null when the
// marketplace's line couldn't be matched to one of ours.
export const returnRequestLines = pgTable(
	"return_request_lines",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		requestId: integer()
			.notNull()
			.references(() => returnRequests.id, { onDelete: "cascade" }),
		orderLineId: integer().references(() => orderLines.id),
		sku: text(),
		quantity: integer().notNull(),
	},
	(t) => [
		check("return_request_lines_quantity_positive", sql`${t.quantity} > 0`),
		index("return_request_lines_request_idx").on(t.requestId),
	],
);

// What a marketplace charged on one order: its latest statement, from its
// finance reports. billedBy is the marketplace that sent the bill, which isn't
// always the order's store: a TikTok order relayed through Shopify is billed
// by TikTok, matched on marketplaceOrderId.
//
// A label's cost belongs to whoever billed it, so no label counts twice:
//   - bought in katasync through Shippo: Shippo bills us, the cost is on
//     shipments, and no marketplace reports it.
//   - bought on a marketplace, in katasync (TikTok) or on its own site
//     (Shopify Shipping, eBay, Amazon Buy Shipping): a label charge here.
//     A TikTok shipment's own cost is only a stand-in until TikTok reports.
//
// No row means the marketplace hasn't reported yet, which is not the same as
// charging nothing: a report with no charges says nothing was charged.
// Refreshing replaces the whole report. Rules live in src/orders/charges.ts.
export const orderCostReports = pgTable(
	"order_cost_reports",
	{
		orderId: integer()
			.notNull()
			.references(() => orders.id),
		billedBy: channel().notNull(),
		// The marketplace says these numbers are final (TikTok's settlement).
		// Others never say so; they're taken as final once the order is old
		// enough to stop being rechecked.
		settled: boolean().notNull(),
		// The marketplace says the order needs no label: picked up, or sold
		// in person. Otherwise a shipped order with no label cost is missing
		// one.
		noLabel: boolean().notNull().default(false),
		// Its label figures are a stand-in until it catches up (Shopify's
		// timeline, before its labels report has the order).
		labelsPending: boolean().notNull().default(false),
		fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.orderId, t.billedBy] })],
);

// When katasync last asked a marketplace about an order's charges, whatever
// came back, so the refresh can back off (src/orders/cost-refresh.ts). error
// is why the last ask failed, for Diagnostics; null when it worked, even if
// the marketplace had nothing yet.
export const orderCostChecks = pgTable(
	"order_cost_checks",
	{
		orderId: integer()
			.notNull()
			.references(() => orders.id),
		billedBy: channel().notNull(),
		checkedAt: timestamp({ withTimezone: true }).notNull(),
		error: text(),
	},
	(t) => [primaryKey({ columns: [t.orderId, t.billedBy] })],
);

export const chargeKind = pgEnum("charge_kind", [
	"fee",
	"label",
	// The carrier re-billing a label after the fact, for a size or weight
	// other than declared. Kept apart from "label" so what the box got wrong
	// never hides inside the label's price.
	"postage_adjustment",
	// Money given back to the buyer.
	"refund",
	// Anything else the marketplace adds or takes back, e.g. a reimbursement.
	"adjustment",
]);

// One line of a report. Positive is money we lose, negative is money back
// (a refunded fee, a reimbursement). Amounts are in the store's currency.
export const orderCharges = pgTable(
	"order_charges",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		orderId: integer().notNull(),
		billedBy: channel().notNull(),
		kind: chargeKind().notNull(),
		// The marketplace's own wording, e.g. "Referral fee".
		description: text().notNull(),
		amount: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	},
	(t) => [
		foreignKey({
			name: "order_charges_report_fk",
			columns: [t.orderId, t.billedBy],
			foreignColumns: [orderCostReports.orderId, orderCostReports.billedBy],
		}).onDelete("cascade"),
		index("order_charges_report_idx").on(t.orderId, t.billedBy),
		check("order_charges_amount_not_zero", sql`${t.amount} <> 0`),
		check(
			"order_charges_description_given",
			sql`btrim(${t.description}) <> ''`,
		),
	],
);

// One pass of one channel's order sync (scripts/sync.ts), for Diagnostics.
// finishedAt is null while it runs, or if the worker died mid-pass. error is
// why the whole pass failed; problems counts single orders that went wrong
// (see syncIssues). Rules live in src/diagnostics/runs.ts.
export const syncRuns = pgTable(
	"sync_runs",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		channel: channel().notNull(),
		startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp({ withTimezone: true }),
		orders: integer().notNull().default(0),
		problems: integer().notNull().default(0),
		error: text(),
	},
	(t) => [index("sync_runs_channel_started_idx").on(t.channel, t.startedAt)],
);

// What went wrong with one order in a run, e.g. "#5536" / "no product for
// KNIFE-5". Capped per run so a systemic failure can't flood the table; the
// run's problems count stays exact.
export const syncIssues = pgTable(
	"sync_issues",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		runId: integer()
			.notNull()
			.references(() => syncRuns.id, { onDelete: "cascade" }),
		// The order or SKU it's about, when there is one.
		reference: text(),
		message: text().notNull(),
	},
	(t) => [index("sync_issues_run_idx").on(t.runId)],
);

// A box we ship in. Quick ship finds it by name or size.
export const packages = pgTable(
	"packages",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		// Only when the size alone doesn't say which box (two the same size).
		name: text(),
		lengthMm: integer().notNull(),
		widthMm: integer().notNull(),
		heightMm: integer().notNull(),
		// The empty box, so a weight estimate can include it.
		weightGrams: integer().notNull().default(0),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [check("packages_name_not_blank", sql`${t.name} <> ''`)],
);

// One send to one address: the boxes that went out together, for every
// order packed into them. One order can be in at most one live dispatch (one
// with a box not voided). contentsKey is everything in it, merged across
// orders; quick ship reuses the last dispatch with the same contents.
// Rules live in src/shipping/dispatch.ts.
export const dispatches = pgTable(
	"dispatches",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		contentsKey: text().notNull(),
		// When every planned box's label was bought. Null while buying, or
		// when a box failed part way: such a dispatch never sends tracking,
		// it can only be voided.
		boughtAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("dispatches_contents_idx").on(t.contentsKey, t.createdAt)],
);

// The orders in a dispatch, and handing its tracking to each one's
// marketplace. Sent: when it got there, and the marketplace's id for that
// fulfillment (Shopify needs it to cancel on void). Not sent: why, shown with
// a retry. Kept per order because a combined box can reach one marketplace
// and be refused by another.
//
// A refused send is tried again on its own (src/shipping/retry.ts) for ten
// minutes from the first refusal: channelRetryAt is when the next try is due,
// and null once it's sent or katasync has stopped trying.
export const dispatchOrders = pgTable(
	"dispatch_orders",
	{
		dispatchId: integer()
			.notNull()
			.references(() => dispatches.id),
		orderId: integer()
			.notNull()
			.references(() => orders.id),
		channelSentAt: timestamp({ withTimezone: true }),
		channelFulfillmentId: text(),
		channelError: text(),
		channelFirstFailedAt: timestamp({ withTimezone: true }),
		channelAttempts: integer().notNull().default(0),
		channelRetryAt: timestamp({ withTimezone: true }),
		// When voiding finished for this order: tracking taken back off its
		// marketplace where possible, and the order back on To ship. Null on a
		// voided dispatch means voiding again resumes this order.
		reversedAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		primaryKey({ columns: [t.dispatchId, t.orderId] }),
		index("dispatch_orders_order_idx").on(t.orderId),
		index("dispatch_orders_retry_idx").on(t.channelRetryAt),
	],
);

// One box's label, in a dispatch. Also what quick ship learns from: the
// weight the same items shipped at, and which service gets picked for a box.
export const shipments = pgTable(
	"shipments",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		dispatchId: integer()
			.notNull()
			.references(() => dispatches.id),
		packageId: integer().references(() => packages.id),
		lengthMm: integer().notNull(),
		widthMm: integer().notNull(),
		heightMm: integer().notNull(),
		weightGrams: integer().notNull(),
		// Aerosols inside: its PDF gets the Limited Quantity mark as a second
		// page (see hazmat.ts).
		hazmat: boolean().notNull().default(false),
		// "shippo" for now; Amazon and TikTok labels come later.
		provider: text().notNull(),
		carrier: text().notNull(),
		carrierToken: text(),
		// The provider's service code, e.g. Shippo's "usps_ground_advantage".
		service: text().notNull(),
		serviceName: text().notNull(),
		cost: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
		insuredAmount: numeric({ precision: 12, scale: 2, mode: "number" }),
		// The label asks for a signature on delivery.
		signature: boolean().notNull().default(false),
		trackingNumber: text(),
		trackingUrl: text(),
		// The provider's own link to the label. TikTok's expire in a day, so
		// TikTok labels have none and are fetched by package ID.
		labelUrl: text(),
		// The label PDF itself, saved when bought (or on first print), so a
		// reprint never depends on the provider. Served at /labels/<id>.
		labelPdf: bytea(),
		externalId: text().notNull().unique(),
		// Bought with a test key: a sample label that can't actually ship.
		test: boolean().notNull(),
		storefrontTrackingError: text(),
		// Voiding asks the provider for the postage back. Refunds can take
		// days (USPS); refundStatus is the provider's word on it.
		voidedAt: timestamp({ withTimezone: true }),
		refundStatus: text(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("shipments_dispatch_idx").on(t.dispatchId)],
);

// A company we buy from. `code` is the short name Sumtracker used, e.g. "CANAM".
export const suppliers = pgTable(
	"suppliers",
	{
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
		// How many critical products (marked, A items, or parts blocking a set)
		// needing ordering make a suggested PO ready whatever its total.
		criticalThreshold: integer().notNull().default(2),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		check(
			"suppliers_critical_threshold_positive",
			sql`${t.criticalThreshold} > 0`,
		),
	],
);

// What suppliers sell in, e.g. CASE. Edited in Settings; renames carry over to
// every product that uses the unit. EACH is one of the product itself, always
// exists, and can't be renamed or removed. Rules live in src/purchasing/units.ts.
export const purchaseUnits = pgTable("purchase_units", {
	name: text().primaryKey(),
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
		// What they sell it in, and how many of the product one holds: a CASE of
		// 30. POs are ordered and received in this unit; stock counts the product.
		unit: text()
			.notNull()
			.default("EACH")
			.references(() => purchaseUnits.name, { onUpdate: "cascade" }),
		packSize: integer().notNull().default(1),
		// How many the supplier says one unit holds, printed on POs: the 5 in
		// their "PACK of 5". Usually packSize, but differs when what they count
		// isn't what we stock, e.g. their PACK of 5 is one of our product. Only
		// ever printed; packSize does all the math.
		supplierCount: integer().notNull(),
		// What the supplier charges per unit above, USD. Starts each PO line;
		// receiving updates it to the last price paid.
		cost: numeric({ precision: 12, scale: 4, mode: "number" }),
		// Fewest units above they'll sell, e.g. 2 cases.
		minimumQuantity: integer().notNull().default(1),
	},
	(t) => [
		index("product_suppliers_supplier_idx").on(t.supplierId),
		check("product_suppliers_minimum_positive", sql`${t.minimumQuantity} > 0`),
		check("product_suppliers_pack_size_positive", sql`${t.packSize} > 0`),
		check(
			"product_suppliers_supplier_count_positive",
			sql`${t.supplierCount} > 0`,
		),
		check(
			"product_suppliers_each_is_one",
			sql`${t.unit} <> 'EACH' or (${t.packSize} = 1 and ${t.supplierCount} = 1)`,
		),
	],
);

// suggested: today's reorder suggestion, opened to look at. It follows the
// suggestion until its first change makes it a draft.
// draft: still being edited; not on order yet.
// sent: emailed to the supplier. Stays sent while partly received.
// closed: everything arrived, or we stopped waiting for the rest.
// cancelled: never sent, or sent and called off before anything arrived.
export const purchaseOrderStatus = pgEnum("purchase_order_status", [
	"suggested",
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
		// One draft per supplier, so suggestions have one place to go. A
		// suggested PO holds the same place. Written as the statuses it isn't,
		// since the migration adding "suggested" can't name it yet.
		uniqueIndex("purchase_orders_one_draft")
			.on(t.supplierId)
			.where(sql`${t.status} not in ('sent', 'closed', 'cancelled')`),
		// Lets a supplier invoice point at a PO and its supplier together, so
		// an invoice can't name one supplier and a PO from another.
		unique("purchase_orders_id_supplier").on(t.id, t.supplierId),
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
		// What this PO orders in (a CASE of 30), and the fewest the supplier
		// sells. Copied from the product's supplier defaults when the line is
		// made; changing them here changes only this PO unless they're also set
		// as the default (src/purchasing/units.ts).
		unit: text().notNull().default("EACH"),
		packSize: integer().notNull().default(1),
		// The count printed on the PO, as on productSuppliers.
		supplierCount: integer().notNull(),
		minimumQuantity: integer().notNull().default(1),
		// How many of `unit` we expect. Receiving puts quantity × packSize on
		// the shelf. After sending it can still change, when we keep what the
		// supplier got wrong; 0 means none are coming.
		quantity: integer().notNull(),
		// USD per `unit`. Null when nobody knows the price yet.
		unitCost: numeric({ precision: 12, scale: 4, mode: "number" }),
		// What the supplier was sent, saved once by sending and never changed:
		// the PDF prints these, so changes made since never reach the supplier.
		// Null on drafts and on lines added after sending.
		sentQuantity: integer(),
		sentUnitCost: numeric({ precision: 12, scale: 4, mode: "number" }),
		// Set by hand on a draft: Update leaves this line's quantity alone.
		locked: boolean().notNull().default(false),
		// What whoever unpacked it wants known, e.g. "2 crushed, kept". Shown
		// above the line when receiving. Never printed; the supplier doesn't
		// see it. Null when there's none, never blank.
		receivingNote: text(),
		// Lines list in this order, then by id. Putting back a line that was
		// taken off gives it its old time, so it returns to where it sat.
		addedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("purchase_order_lines_product").on(t.purchaseOrderId, t.productId),
		// Drafts take a line off instead of keeping it at 0 (orders.ts).
		check(
			"purchase_order_lines_quantity_not_negative",
			sql`${t.quantity} >= 0`,
		),
		check(
			"purchase_order_lines_sent_cost_needs_sent",
			sql`${t.sentUnitCost} is null or ${t.sentQuantity} is not null`,
		),
		check("purchase_order_lines_pack_size_positive", sql`${t.packSize} > 0`),
		check(
			"purchase_order_lines_supplier_count_positive",
			sql`${t.supplierCount} > 0`,
		),
		check(
			"purchase_order_lines_minimum_positive",
			sql`${t.minimumQuantity} > 0`,
		),
		check(
			"purchase_order_lines_receiving_note_not_blank",
			sql`${t.receivingNote} is null or btrim(${t.receivingNote}) <> ''`,
		),
	],
);

// Parts of a draft's tool set that this PO leaves out, skipped by hand (e.g.
// there's stock already). A set only orders the parts bought from the PO's
// supplier anyway; skipping also stops a part counting as missing. Rows from
// before skipping existed are parts moved to their supplier's draft. Keyed by
// the set rather than its line, so taking the set off and Undo keeps them
// skipped. Rules live in src/purchasing/orders.ts.
export const purchaseOrderSkippedParts = pgTable(
	"purchase_order_moved_parts",
	{
		purchaseOrderId: integer()
			.notNull()
			.references(() => purchaseOrders.id, { onDelete: "cascade" }),
		setProductId: integer()
			.notNull()
			.references(() => products.id),
		partProductId: integer()
			.notNull()
			.references(() => products.id),
	},
	(t) => [
		primaryKey({
			columns: [t.purchaseOrderId, t.setProductId, t.partProductId],
		}),
	],
);

// Changes made to a PO after it was sent, which the supplier is never told
// about, for its timeline. Changes a receipt made are kept on the receipt.
// Keyed by product rather than line, since a line added after sending can
// come off again.
// added: put on after sending (quantityAfter). removed: taken back off
// (quantityBefore). quantity / cost: one changed (before and after).
export const purchaseOrderAmendmentKind = pgEnum(
	"purchase_order_amendment_kind",
	["added", "removed", "quantity", "cost"],
);

export const purchaseOrderAmendments = pgTable(
	"purchase_order_amendments",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		purchaseOrderId: integer()
			.notNull()
			.references(() => purchaseOrders.id),
		productId: integer()
			.notNull()
			.references(() => products.id),
		kind: purchaseOrderAmendmentKind().notNull(),
		quantityBefore: integer(),
		quantityAfter: integer(),
		unitCostBefore: numeric({ precision: 12, scale: 4, mode: "number" }),
		unitCostAfter: numeric({ precision: 12, scale: 4, mode: "number" }),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("purchase_order_amendments_po_idx").on(t.purchaseOrderId),
		check(
			"purchase_order_amendments_shape",
			sql`case ${t.kind}
				when 'added' then ${t.quantityAfter} is not null and ${t.quantityBefore} is null
				when 'removed' then ${t.quantityBefore} is not null and ${t.quantityAfter} is null
				when 'quantity' then ${t.quantityBefore} is not null and ${t.quantityAfter} is not null
				else ${t.quantityBefore} is null and ${t.quantityAfter} is null
			end`,
		),
	],
);

// How many of each tool set a PO had when it was sent, since sending splits
// a set into its parts. A set on several suppliers' POs gets each one's parts
// from that supplier, so this is how a draft knows its set's other parts are
// already on order.
export const purchaseOrderSentSets = pgTable(
	"purchase_order_sent_sets",
	{
		purchaseOrderId: integer()
			.notNull()
			.references(() => purchaseOrders.id, { onDelete: "cascade" }),
		setProductId: integer()
			.notNull()
			.references(() => products.id),
		sets: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.purchaseOrderId, t.setProductId] }),
		check("purchase_order_sent_sets_positive", sql`${t.sets} > 0`),
	],
);

// A supplier's bill for a PO, as written on it. The number is unique per
// supplier, ignoring case, so the same invoice can't be recorded (and paid)
// twice. Rules live in src/purchasing/invoices.ts.
export const supplierInvoices = pgTable(
	"supplier_invoices",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		purchaseOrderId: integer().notNull(),
		supplierId: integer().notNull(),
		// Their invoice number, e.g. TSW-INV-58213.
		number: text().notNull(),
		invoicedOn: date({ mode: "string" }).notNull(),
		dueOn: date({ mode: "string" }),
		// What they say is due, USD, freight and tax included.
		total: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		foreignKey({
			name: "supplier_invoices_po_fk",
			columns: [t.purchaseOrderId, t.supplierId],
			foreignColumns: [purchaseOrders.id, purchaseOrders.supplierId],
		}),
		index("supplier_invoices_po_idx").on(t.purchaseOrderId),
		uniqueIndex("supplier_invoices_number").on(
			t.supplierId,
			sql`lower(${t.number})`,
		),
		check("supplier_invoices_number_given", sql`btrim(${t.number}) <> ''`),
		check("supplier_invoices_total_not_negative", sql`${t.total} >= 0`),
		check(
			"supplier_invoices_due_after_invoiced",
			sql`${t.dueOn} is null or ${t.dueOn} >= ${t.invoicedOn}`,
		),
	],
);

// Each time units of a line are received, and each undo (a negative quantity
// pointing at the receipt it reverses). Counted in the line's unit, like its
// quantity. A line's received count is the sum.
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
		// When this receipt changed the line's quantity (more came than
		// expected, or it was marked as all that's coming): what it was before
		// and after, so undoing the receipt can put it back.
		quantityBefore: integer(),
		quantityAfter: integer(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("purchase_order_receipts_line_idx").on(t.lineId),
		check(
			"purchase_order_receipts_quantity_change_whole",
			sql`(${t.quantityBefore} is null) = (${t.quantityAfter} is null)`,
		),
		check("purchase_order_receipts_quantity_nonzero", sql`${t.quantity} <> 0`),
		check(
			"purchase_order_receipts_undo_is_negative",
			sql`(${t.undoesId} is null) = (${t.quantity} > 0)`,
		),
		// For discounts that came with a receipt, so theirs is on the same line.
		unique("purchase_order_receipts_id_line").on(t.id, t.lineId),
	],
);

// A percent or dollars off some of a PO line's units, e.g. 10% off all of
// them, $12 off the 4 that came dented, or 1 free. The amount is for those
// units together. The line's total is its quantity × price less these.
// Rules, and what they cover once the line changes, live in
// src/purchasing/discount.ts; changes go through src/purchasing/orders.ts.
export const purchaseOrderDiscounts = pgTable(
	"purchase_order_discounts",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		lineId: integer()
			.notNull()
			.references(() => purchaseOrderLines.id, { onDelete: "cascade" }),
		// How many of the line's unit it covers. Null: every unit no other
		// discount covers, so it follows the line's quantity.
		units: integer(),
		// Exactly one of these.
		percent: numeric({ precision: 5, scale: 2, mode: "number" }),
		amount: numeric({ precision: 12, scale: 2, mode: "number" }),
		// The receipt it came with, e.g. a free one in the box. Undoing the
		// receipt takes it off.
		receiptId: integer(),
		// On the PO when it was sent, so the PDF keeps printing it. Taking one
		// off after that only marks it removed; anything else is deleted.
		sent: boolean().notNull().default(false),
		removedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("purchase_order_discounts_line_idx").on(t.lineId),
		foreignKey({
			columns: [t.receiptId, t.lineId],
			foreignColumns: [purchaseOrderReceipts.id, purchaseOrderReceipts.lineId],
		}),
		// Two discounts can't both take the rest.
		uniqueIndex("purchase_order_discounts_one_rest")
			.on(t.lineId)
			.where(sql`${t.units} is null and ${t.removedAt} is null`),
		check(
			"purchase_order_discounts_units_positive",
			sql`${t.units} is null or ${t.units} > 0`,
		),
		check(
			"purchase_order_discounts_one_kind",
			sql`(${t.percent} is null) <> (${t.amount} is null)`,
		),
		check(
			"purchase_order_discounts_percent_range",
			sql`${t.percent} is null or (${t.percent} > 0 and ${t.percent} <= 100)`,
		),
		check(
			"purchase_order_discounts_amount_positive",
			sql`${t.amount} is null or ${t.amount} > 0`,
		),
		// A receipt's discount covers some of what came, never "the rest".
		check(
			"purchase_order_discounts_receipt_units",
			sql`${t.receiptId} is null or ${t.units} is not null`,
		),
		check(
			"purchase_order_discounts_removed_was_sent",
			sql`${t.removedAt} is null or ${t.sent}`,
		),
	],
);

// What a damage report asks the supplier for: money back, or the same
// number again. Chosen per item when the report is sent.
export const damageRemedy = pgEnum("damage_remedy", ["credit", "replacement"]);

// A report sent to the supplier about damaged items on one PO. Its items are
// the purchaseOrderDamages pointing at it. Made only by sending it.
export const purchaseOrderDamageReports = pgTable(
	"purchase_order_damage_reports",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		purchaseOrderId: integer()
			.notNull()
			.references(() => purchaseOrders.id),
		sentTo: text().notNull(),
		sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("purchase_order_damage_reports_po_idx").on(t.purchaseOrderId)],
);

// Items of a line that arrived damaged. Counted in single items, not the
// line's unit: one blade in a case of 12 can break. They come off the shelf
// when recorded (batchId) and can't exceed what was received. Until a report
// takes them they can be taken back, which puts them back on the shelf;
// once reported they stay, with what was asked for. Rules live in
// src/purchasing/damage.ts.
export const purchaseOrderDamages = pgTable(
	"purchase_order_damages",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		lineId: integer()
			.notNull()
			.references(() => purchaseOrderLines.id),
		quantity: integer().notNull(),
		description: text().notNull(),
		// The ledger batch that took them off the shelf.
		batchId: uuid().notNull().unique(),
		reportId: integer().references(() => purchaseOrderDamageReports.id),
		remedy: damageRemedy(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("purchase_order_damages_line_idx").on(t.lineId),
		check("purchase_order_damages_quantity_positive", sql`${t.quantity} > 0`),
		check(
			"purchase_order_damages_description_given",
			sql`btrim(${t.description}) <> ''`,
		),
		check(
			"purchase_order_damages_reported_with_remedy",
			sql`(${t.reportId} is null) = (${t.remedy} is null)`,
		),
	],
);

// Photos of damage, as uploaded: JPEG, PNG, or WebP, checked by their bytes.
export const purchaseOrderDamagePhotos = pgTable(
	"purchase_order_damage_photos",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		damageId: integer()
			.notNull()
			.references(() => purchaseOrderDamages.id, { onDelete: "cascade" }),
		contentType: text().notNull(),
		data: bytea().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("purchase_order_damage_photos_damage_idx").on(t.damageId),
		check(
			"purchase_order_damage_photos_type",
			sql`${t.contentType} in ('image/jpeg', 'image/png', 'image/webp')`,
		),
		check(
			"purchase_order_damage_photos_size",
			sql`octet_length(${t.data}) between 1 and 4500000`,
		),
	],
);

// Links that let something without a session, like Claude's shell, upload
// photos of one damage. Only the hash is kept; the link works until it
// expires.
export const damagePhotoUploads = pgTable("damage_photo_uploads", {
	tokenHash: text().primaryKey(),
	damageId: integer()
		.notNull()
		.references(() => purchaseOrderDamages.id, { onDelete: "cascade" }),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
});

// Sign-in. katasync has one shared company account, so there are no users:
// each phone or computer gets its own passkey, named so a lost one can be
// removed. Rules live in src/auth/.
export const passkeys = pgTable("passkeys", {
	// The credential ID the browser reports, base64url.
	id: text().primaryKey(),
	// COSE public key, base64url.
	publicKey: text().notNull(),
	// Signature counter. Synced passkeys (iCloud, Google) always report 0.
	counter: bigint({ mode: "number" }).notNull().default(0),
	transports: text().array().notNull().default(sql`'{}'::text[]`),
	// What device it's on, e.g. "Warehouse iPhone".
	name: text().notNull(),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	lastUsedAt: timestamp({ withTimezone: true }),
});

// A signed-in browser. The cookie holds a random token; only its SHA-256 is
// stored, so a database leak can't sign anyone in. Removing a passkey signs
// out the browsers it signed in.
export const sessions = pgTable(
	"sessions",
	{
		tokenHash: text().primaryKey(),
		passkeyId: text()
			.notNull()
			.references(() => passkeys.id, { onDelete: "cascade" }),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		// Pushed forward as the browser keeps being used.
		expiresAt: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [index("sessions_passkey_idx").on(t.passkeyId)],
);

// A one-time link that lets a new device create a passkey. Made by a signed-in
// device or by `pnpm auth:setup-link` on the server. Stored hashed, like
// sessions.
export const setupLinks = pgTable("setup_links", {
	tokenHash: text().primaryKey(),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
	usedAt: timestamp({ withTimezone: true }),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// A WebAuthn challenge waiting for its answer. Each is used once, so a
// captured sign-in can't be replayed.
export const authChallenges = pgTable("auth_challenges", {
	challenge: text().primaryKey(),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
});

// OAuth for /mcp (src/auth/oauth.ts). An app like Claude registers itself
// (oauth_clients), someone signed in approves it (oauth_grants), and the app
// trades the one-time code for tokens (oauth_tokens). Disconnecting an app
// deletes its grant, and with it every code and token.

// An app that registered itself. Anyone can register, so one that's never
// approved is cleared out after a day.
export const oauthClients = pgTable("oauth_clients", {
	id: text().primaryKey(),
	// What the app calls itself, e.g. "Claude".
	name: text().notNull(),
	// Where approval sends the browser back; only these, matched exactly.
	redirectUris: text().array().notNull(),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// One approval of an app: what it may do, until disconnected in Settings.
export const oauthGrants = pgTable(
	"oauth_grants",
	{
		id: uuid().primaryKey().defaultRandom(),
		clientId: text()
			.notNull()
			.references(() => oauthClients.id, { onDelete: "cascade" }),
		// Read only gets only the tools that read.
		canWrite: boolean().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		lastUsedAt: timestamp({ withTimezone: true }),
	},
	(t) => [index("oauth_grants_client_idx").on(t.clientId)],
);

// The code approval hands the app, traded once for tokens within minutes.
// Bound to the redirect it was sent to and the app's PKCE challenge, so a
// code caught on the way can't be used.
export const oauthCodes = pgTable("oauth_codes", {
	codeHash: text().primaryKey(),
	grantId: uuid()
		.notNull()
		.references(() => oauthGrants.id, { onDelete: "cascade" }),
	redirectUri: text().notNull(),
	codeChallenge: text().notNull(),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
	// Kept once used, so a second try is caught and ends the grant.
	usedAt: timestamp({ withTimezone: true }),
});

export const oauthTokenKind = pgEnum("oauth_token_kind", ["access", "refresh"]);

// An access token calls /mcp for an hour; a refresh token gets a new pair
// once. Only hashes are kept.
export const oauthTokens = pgTable(
	"oauth_tokens",
	{
		tokenHash: text().primaryKey(),
		kind: oauthTokenKind().notNull(),
		grantId: uuid()
			.notNull()
			.references(() => oauthGrants.id, { onDelete: "cascade" }),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		// When a refresh token was traded. Kept, so a second try is caught and
		// ends the grant.
		usedAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		index("oauth_tokens_grant_idx").on(t.grantId),
		check(
			"oauth_tokens_only_refresh_used",
			sql`${t.kind} = 'refresh' or ${t.usedAt} is null`,
		),
	],
);

// The password of katasync_mcp, the login the MCP query tool connects as, set
// the first time it's needed (src/mcp/query.ts). The role and what it may
// read are in drizzle/0027_mcp_role.sql.
export const mcpLogin = pgTable(
	"mcp_login",
	{
		id: smallint().primaryKey().default(1),
		password: text().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [check("mcp_login_single", sql`${t.id} = 1`)],
);

// The one key pair katasync signs QZ Tray print requests with, made the first
// time it's needed (src/printing/qz.ts). Packing computers trust the
// certificate through the setup script, so replacing it means running that
// script on each of them again.
export const qzCertificate = pgTable(
	"qz_certificate",
	{
		id: smallint().primaryKey().default(1),
		// PEM.
		certificate: text().notNull(),
		// PKCS#8 PEM. Never sent to a browser.
		privateKey: text().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [check("qz_certificate_single", sql`${t.id} = 1`)],
);

// Views defined in drizzle/0020_reporting_views.sql, so every report counts
// stock and sales the same way.

// Stock on our own shelves per stocked product, warehouse and retail store
// (Amazon's FBA stock left out).
export const ownedStock = pgView("owned_stock", {
	productId: integer().notNull(),
	sku: text().notNull(),
	onHand: integer().notNull(),
}).existing();

// Units that left our shelves, per order line: tool sets as their parts,
// without cancelled or FBA orders, or lines not matched to a product.
export const salesUnits = pgView("sales_units", {
	productId: integer().notNull(),
	orderId: integer().notNull(),
	storeId: integer().notNull(),
	placedAt: timestamp({ withTimezone: true }).notNull(),
	units: integer().notNull(),
}).existing();

// What each order made, defined in the order profit migration: revenue,
// cost, fees, labels, refunds and adjustments, each with how sure it is, and
// profit. One row per order not cancelled. Statuses are explained there.
export const orderProfit = pgView("order_profit", {
	orderId: integer().notNull(),
	storeId: integer().notNull(),
	soldOn: channel().notNull(),
	placedAt: timestamp({ withTimezone: true }).notNull(),
	revenue: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	shippingCharged: numeric({
		precision: 12,
		scale: 2,
		mode: "number",
	}).notNull(),
	cost: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	costKnown: boolean().notNull(),
	fees: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	feesStatus: text({ enum: ["final", "reported", "estimated"] }).notNull(),
	labels: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	labelsStatus: text({
		enum: [
			"known",
			"stand_in",
			"not_needed",
			"not_shipped",
			"awaiting",
			"missing",
		],
	}).notNull(),
	// What carriers re-billed for size or weight, kept out of labels.
	postageAdjustments: numeric({
		precision: 12,
		scale: 2,
		mode: "number",
	}).notNull(),
	refunds: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	adjustments: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	profit: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	complete: boolean().notNull(),
	// Confirmed and shipped (or needing no shipping): what the Profit tab
	// counts.
	shipped: boolean().notNull(),
	// Refunded in full, with items it sold still to be received back; their
	// cost isn't counted until then, or until 60 days pass.
	awaitingReturn: boolean().notNull(),
}).existing();

// One row per item sold (order line with units; an order cancelled down to
// nothing keeps its lines), with its share of its order's charges, defined
// in drizzle/0051_order_line_profit.sql. Its lines add up to the order's
// profit in order_profit.
export const orderLineProfit = pgView("order_line_profit", {
	lineId: integer().notNull(),
	orderId: integer().notNull(),
	productId: integer(),
	soldOn: channel().notNull(),
	placedAt: timestamp({ withTimezone: true }).notNull(),
	quantity: integer().notNull(),
	// Units sent back to the shelf, which cost nothing.
	restocked: integer().notNull(),
	revenue: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	// Null when the product has no cost, or the line no product.
	cost: numeric({ precision: 12, scale: 2, mode: "number" }),
	costKnown: boolean().notNull(),
	fees: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	labels: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	shippingCharged: numeric({
		precision: 12,
		scale: 2,
		mode: "number",
	}).notNull(),
	postageAdjustments: numeric({
		precision: 12,
		scale: 2,
		mode: "number",
	}).notNull(),
	refunds: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	adjustments: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	profit: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
	feesStatus: text({ enum: ["final", "reported", "estimated"] }).notNull(),
	labelsStatus: text({
		enum: [
			"known",
			"stand_in",
			"not_needed",
			"not_shipped",
			"awaiting",
			"missing",
		],
	}).notNull(),
	complete: boolean().notNull(),
	shipped: boolean().notNull(),
	// Units refunded and presumed on their way back, which cost nothing yet.
	returning: integer().notNull(),
}).existing();

// What's due back, one row per line expected, defined in
// drizzle/0061_returns_tab.sql. Every line of an order has its order's state.
export const returnStates = [
	"on_its_way",
	"requested",
	"refunded",
	"maybe",
] as const;
export type ReturnState = (typeof returnStates)[number];
export const orderReturnsDue = pgView("order_returns_due", {
	lineId: integer().notNull(),
	orderId: integer().notNull(),
	state: text({ enum: returnStates }).notNull(),
	// Units expected back; for a maybe, the most that could come.
	expected: integer().notNull(),
}).existing();

// count_log with the drift worked out and undone counts marked, defined in
// the count log migration. Drift is counted minus expected.
export const countHistory = pgView("count_history", {
	id: bigint({ mode: "number" }).notNull(),
	productId: integer().notNull(),
	sku: text().notNull(),
	locationId: integer().notNull(),
	countedAt: timestamp({ withTimezone: true }).notNull(),
	expected: integer().notNull(),
	counted: integer().notNull(),
	drift: integer().notNull(),
	undone: boolean().notNull(),
}).existing();

// How many of each line came back, by the best evidence there is (received,
// requested, or refunded in full), defined in drizzle/0064_return_rates.sql.
// Lines with a product, from orders not cancelled or shipped by the
// marketplace.
export const orderLineReturns = pgView("order_line_returns", {
	lineId: integer().notNull(),
	orderId: integer().notNull(),
	productId: integer().notNull(),
	soldOn: channel().notNull(),
	placedAt: timestamp({ withTimezone: true }).notNull(),
	sold: integer().notNull(),
	returned: integer().notNull(),
	received: integer().notNull(),
	restocked: integer().notNull(),
	requested: integer().notNull(),
	refundedInFull: boolean().notNull(),
	// The marketplaces' return reasons, as they word them.
	reasons: text().array().notNull(),
}).existing();

// Each product's return rate by order over the year that ended 45 days
// ago, against what its orders would bring at each channel's rate, defined
// in drizzle/0066_return_rates_by_order.sql. Units are kept for cost and
// stock; the rates count orders, since a buyer decides once per box.
export const productReturnRates = pgView("product_return_rates", {
	productId: integer().notNull(),
	sku: text().notNull(),
	orders: integer().notNull(),
	ordersReturned: integer().notNull(),
	sold: integer().notNull(),
	returned: integer().notNull(),
	received: integer().notNull(),
	restocked: integer().notNull(),
	rate: numeric({ precision: 6, scale: 4, mode: "number" }).notNull(),
	// The lowest rate its orders make likely (Wilson, 95%).
	rateLow: numeric({ precision: 6, scale: 4, mode: "number" }).notNull(),
	// Its orders' rate at each channel's rate: the bar it's held to.
	baseline: numeric({ precision: 6, scale: 4, mode: "number" }).notNull(),
	// Returned orders that baseline brings, and how many it doesn't explain.
	expected: numeric({ precision: 12, scale: 1, mode: "number" }).notNull(),
	excess: numeric({ precision: 12, scale: 1, mode: "number" }).notNull(),
}).existing();

// Every change made through /mcp: which app (token_name), which tool, what it was asked,
// and how it went. Shown on Diagnostics, so a change Claude made can be found.
// Reads aren't kept. Written by src/routes/mcp.ts.
export const mcpCalls = pgTable(
	"mcp_calls",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		tokenName: text().notNull(),
		tool: text().notNull(),
		arguments: jsonb().notNull(),
		ok: boolean().notNull(),
		// The tool's answer or error, cut short.
		result: text().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("mcp_calls_created_idx").on(t.createdAt)],
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

// Settings that apply across the app. One row, made by its migration.
export const settings = pgTable(
	"settings",
	{
		id: smallint().primaryKey().default(1),
		// The min for products without their own range (products.minStock).
		// Their max comes from their sales forecast (inventory/stock-range.ts).
		defaultMinStock: integer().notNull().default(1),
		// Units the retail store keeps for walk-ins: shipped orders and the
		// channels only take what it holds above this (see recordSale).
		retailReserve: integer().notNull().default(0),
	},
	(t) => [
		check("settings_single", sql`${t.id} = 1`),
		check("settings_stock_range", sql`${t.defaultMinStock} >= 0`),
		check("settings_retail_reserve", sql`${t.retailReserve} >= 0`),
	],
);

// Problems dismissed on Diagnostics. `key` names the thing (see
// src/diagnostics/dismissals.ts). It stays hidden while its error reads the
// same, and shows again once the error changes.
export const dismissals = pgTable("dismissals", {
	key: text().primaryKey(),
	error: text().notNull(),
	dismissedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
