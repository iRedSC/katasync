import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { channel } from "./schema";

export const webhookInbox = pgTable(
	"webhook_inbox",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		channel: channel().notNull(),
		orderId: text().notNull(),
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
		uniqueIndex("webhook_inbox_order_idx").on(t.channel, t.orderId),
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
