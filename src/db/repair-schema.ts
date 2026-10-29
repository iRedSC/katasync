import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	doublePrecision,
	foreignKey,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { orderLines, products } from "./schema";

// Tool repairs (src/repairs), of two kinds. A customer's is billed on a
// Shopify draft order that katasync keeps in step with its labor and parts;
// the customer lives in Shopify too. A bench job is our own tool, fixed up
// to sell as a refurb: a returned unit or one bought in. Rules live in
// src/repairs/status.ts.

// People in the shop, apart from the shared sign-in, so a repair can say who
// has the tool. Removing one archives them: their repairs keep the name.
export const people = pgTable(
	"people",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		name: text().notNull(),
		technician: boolean().notNull().default(false),
		archivedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("people_name_unique")
			.on(sql`lower(${t.name})`)
			.where(sql`${t.archivedAt} is null`),
		check("people_name_present", sql`length(trim(${t.name})) between 1 and 40`),
	],
);

// received, waiting_parts, in_repair, ready: on the board, moved freely.
// picked_up: a customer's; its draft order was paid, or it had nothing to
//   charge.
// refurbished: a bench job's; listed as the refurb in refurbProductId.
// cancelled: called off; its charges came off the draft order.
export const repairStatus = pgEnum("repair_status", [
	"received",
	"waiting_parts",
	"in_repair",
	"ready",
	"picked_up",
	"cancelled",
	"refurbished",
]);

export const repairKind = pgEnum("repair_kind", ["customer", "bench"]);

// Shown as "R1001", on the ticket tied to its tools.
export const repairs = pgTable(
	"repairs",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity({ startWith: 1001 }),
		status: repairStatus().notNull().default("received"),
		kind: repairKind().notNull().default("customer"),
		// A customer's: the Shopify customer, with what we last read of them,
		// for the board and the ticket. A bench job has none.
		customerId: text(),
		customerName: text(),
		customerPhone: text(),
		customerEmail: text(),
		notes: text().notNull().default(""),
		technicianId: integer().references(() => people.id),
		// Made with the first charge, since Shopify won't keep a draft order
		// with no lines, and gone again when the last comes off.
		draftOrderId: text(),
		draftOrderName: text(),
		// The order the draft became once paid.
		orderId: text(),
		orderName: text(),
		// A bench job's: the catalog product it is, which its refurb is made
		// from. A customer's tools say what each is (repairTools).
		productId: integer().references(() => products.id),
		// A bench job's: the returned line its unit came back on, if any,
		// holding one of that line's units until it's listed; the refurb it
		// was listed as; and the movement that took its parts off the shelf
		// then.
		returnLineId: integer().references(() => orderLines.id),
		// When its unit was counted back at cutover until it was benched:
		// cancelling the job counts it back again (src/orders/cutover.ts).
		cutoverAt: timestamp({ withTimezone: true }),
		refurbProductId: integer().references(() => products.id),
		partsBatchId: uuid(),
		statusChangedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		// Its place in its column's queue, smallest at the top. New ones and
		// ones moved in go last; dropping one between two puts it halfway
		// (src/repairs/queue.ts).
		position: doublePrecision()
			.notNull()
			.default(sql`extract(epoch from now())`),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("repairs_draft_order_unique").on(t.draftOrderId),
		index("repairs_open_idx")
			.on(t.status)
			.where(sql`${t.status} not in ('picked_up', 'cancelled')`),
		index("repairs_customer_idx").on(t.customerId),
		index("repairs_return_line_idx")
			.on(t.returnLineId)
			.where(sql`${t.returnLineId} is not null`),
		// A customer's has a customer; a bench job has no customer, no draft
		// order, and the product it is. Statuses are compared as text: the
		// enum value is new in the same migration.
		check(
			"repairs_customer_by_kind",
			sql`case ${t.kind}::text
				when 'customer' then ${t.customerId} is not null and ${t.customerName} is not null
					and ${t.returnLineId} is null and ${t.refurbProductId} is null
					and ${t.productId} is null
					and ${t.status}::text <> 'refurbished'
				else ${t.customerId} is null and ${t.customerName} is null
					and ${t.customerPhone} is null and ${t.customerEmail} is null
					and ${t.draftOrderId} is null and ${t.orderId} is null
					and ${t.productId} is not null and ${t.status}::text <> 'picked_up'
			end`,
		),
		check(
			"repairs_refurb_when_refurbished",
			sql`(${t.status}::text = 'refurbished') = (${t.refurbProductId} is not null)`,
		),
		check(
			"repairs_draft_name_pair",
			sql`(${t.draftOrderId} is null) = (${t.draftOrderName} is null)`,
		),
		check(
			"repairs_order_pair",
			sql`(${t.orderId} is null) = (${t.orderName} is null)`,
		),
		// Only a paid repair has an order, and then no draft: it became the order.
		check(
			"repairs_order_when_paid",
			sql`${t.orderId} is null or (${t.status} = 'picked_up' and ${t.draftOrderId} is null)`,
		),
		// A closed repair has nothing left to charge on a draft.
		check(
			"repairs_no_draft_when_closed",
			sql`${t.draftOrderId} is null or ${t.status} not in ('picked_up', 'cancelled')`,
		),
		check(
			"repairs_cutover_returned",
			sql`${t.cutoverAt} is null or ${t.returnLineId} is not null`,
		),
	],
);

// The tools on a repair, in the order they came in. A customer's can have
// several; a bench job is its one unit. Each has its own labor and parts,
// and a repair's labor and parts with no tool are for the order as a whole.
export const repairTools = pgTable(
	"repair_tools",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		repairId: integer()
			.notNull()
			.references(() => repairs.id, { onDelete: "cascade" }),
		tool: text().notNull(),
		// The catalog product it is, when picked as one.
		productId: integer().references(() => products.id),
		serial: text(),
		problem: text().notNull().default(""),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("repair_tools_repair_idx").on(t.repairId),
		// What labor and parts point at, so theirs is always on their repair.
		unique("repair_tools_repair_id").on(t.repairId, t.id),
		check("repair_tools_tool_present", sql`length(trim(${t.tool})) > 0`),
	],
);

// Time spent, in the 15-minute steps Shopify's labor variants come in, on
// one of the repair's tools, or none. Taking a tool off takes its time.
export const repairLabor = pgTable(
	"repair_labor",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		repairId: integer()
			.notNull()
			.references(() => repairs.id, { onDelete: "cascade" }),
		toolId: integer(),
		minutes: integer().notNull(),
		note: text().notNull().default(""),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("repair_labor_repair_idx").on(t.repairId),
		foreignKey({
			name: "repair_labor_tool_fk",
			columns: [t.repairId, t.toolId],
			foreignColumns: [repairTools.repairId, repairTools.id],
		}).onDelete("cascade"),
		check(
			"repair_labor_minutes_steps",
			sql`${t.minutes} > 0 and ${t.minutes} <= 6000 and ${t.minutes} % 15 = 0`,
		),
	],
);

// Parts put into the tool. A customer's are charged at their Shopify price,
// and their stock comes off when the paid order syncs in, like any sale. A
// bench job's come off the shelf when it's listed, and add their cost to
// the refurb's. Each is on one of the repair's tools, or none, like labor.
export const repairParts = pgTable(
	"repair_parts",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		repairId: integer()
			.notNull()
			.references(() => repairs.id, { onDelete: "cascade" }),
		toolId: integer(),
		productId: integer()
			.notNull()
			.references(() => products.id),
		quantity: integer().notNull(),
	},
	(t) => [
		unique("repair_parts_one_per_product")
			.on(t.repairId, t.toolId, t.productId)
			.nullsNotDistinct(),
		foreignKey({
			name: "repair_parts_tool_fk",
			columns: [t.repairId, t.toolId],
			foreignColumns: [repairTools.repairId, repairTools.id],
		}).onDelete("cascade"),
		check(
			"repair_parts_quantity_positive",
			sql`${t.quantity} between 1 and 999`,
		),
	],
);
