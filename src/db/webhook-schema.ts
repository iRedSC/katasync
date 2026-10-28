import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { channel } from "./schema";

// What a webhook asks to read again: an order, the returns on an order
// (TikTok's return status change names the order), or one TikTok
// aftersales case.
export const webhookTarget = pgEnum("webhook_target", [
	"order",
	"order_returns",
	"aftersales",
]);

export const webhookInbox = pgTable(
	"webhook_inbox",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		channel: channel().notNull(),
		target: webhookTarget().notNull().default("order"),
		// The target's key (webhook-inbox.ts targetKey): an order's own id,
		// so code from before targets still reads and writes its orders
		// here, and a case target's id under its kind ("aftersales:<id>"),
		// which no order id is.
		targetKey: text("order_id").notNull(),
		eventDigest: text().notNull(),
		generation: integer().notNull().default(1),
		eventAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		failures: integer().notNull().default(0),
		lastError: text(),
		lastErrorAt: timestamp({ withTimezone: true }),
		leaseToken: uuid(),
		leaseExpiresAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		uniqueIndex("webhook_inbox_order_idx").on(t.channel, t.targetKey),
		// Only TikTok sends case events.
		check(
			"webhook_inbox_case_targets_tiktok",
			sql`${t.target} = 'order' or ${t.channel} = 'tiktok'`,
		),
		check(
			"webhook_inbox_case_key",
			sql`${t.target} = 'order' or ${t.targetKey} like ${t.target}::text || ':%'`,
		),
		index("webhook_inbox_due_idx").on(t.nextAttemptAt),
		check(
			"webhook_inbox_lease_pair",
			sql`(${t.leaseToken} is null) = (${t.leaseExpiresAt} is null)`,
		),
		check(
			"webhook_inbox_error_pair",
			sql`(${t.lastError} is null) = (${t.lastErrorAt} is null)`,
		),
		check("webhook_inbox_generation_positive", sql`${t.generation} >= 1`),
		check("webhook_inbox_failures_nonnegative", sql`${t.failures} >= 0`),
	],
);
