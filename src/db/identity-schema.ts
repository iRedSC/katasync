import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	index,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { authChallenges, oauthGrants, passkeys, setupLinks } from "./schema";

// Named people behind the shared company account (src/auth/staff.ts). A
// passkey, setup link, or OAuth grant belongs to one through a sidecar row;
// a passkey or grant without one is an unassigned device or app from before
// staff existed, and keeps working without being credited to anyone. The
// rules the database enforces itself are in src/db/pending/identity.sql.

export const staffRole = pgEnum("staff_role", ["owner", "operator"]);
export const staffStatus = pgEnum("staff_status", ["active", "removed"]);

export const staff = pgTable(
	"staff",
	{
		id: uuid().primaryKey().defaultRandom(),
		name: text().notNull(),
		role: staffRole().notNull(),
		status: staffStatus().notNull().default("active"),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("staff_name_unique").on(sql`lower(${t.name})`),
		check("staff_name_present", sql`length(trim(${t.name})) between 1 and 40`),
	],
);

export const passkeyStaff = pgTable(
	"passkey_staff",
	{
		passkeyId: text()
			.primaryKey()
			.references(() => passkeys.id, { onDelete: "cascade" }),
		staffId: uuid()
			.notNull()
			.references(() => staff.id),
		boundAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("passkey_staff_staff_idx").on(t.staffId)],
);

export const setupLinkScopes = pgTable(
	"setup_link_scopes",
	{
		tokenHash: text()
			.primaryKey()
			.references(() => setupLinks.tokenHash, { onDelete: "cascade" }),
		staffId: uuid()
			.notNull()
			.references(() => staff.id),
		issuedByStaffId: uuid().references(() => staff.id),
		issuedBySystem: text(),
	},
	(t) => [
		check(
			"setup_link_scopes_one_issuer",
			sql`(${t.issuedByStaffId} is null) <> (${t.issuedBySystem} is null)`,
		),
	],
);

export const challengePurpose = pgEnum("auth_challenge_purpose", [
	"register",
	"login",
]);

export const authChallengeBindings = pgTable(
	"auth_challenge_bindings",
	{
		challenge: text()
			.primaryKey()
			.references(() => authChallenges.challenge, { onDelete: "cascade" }),
		purpose: challengePurpose().notNull(),
		setupTokenHash: text(),
	},
	(t) => [
		check(
			"auth_challenge_bindings_shape",
			sql`(${t.purpose} = 'register') = (${t.setupTokenHash} is not null)`,
		),
	],
);

export const oauthGrantStaff = pgTable(
	"oauth_grant_staff",
	{
		grantId: uuid()
			.primaryKey()
			.references(() => oauthGrants.id, { onDelete: "cascade" }),
		staffId: uuid()
			.notNull()
			.references(() => staff.id),
		passkeyId: text().references(() => passkeys.id, { onDelete: "set null" }),
	},
	(t) => [index("oauth_grant_staff_staff_idx").on(t.staffId)],
);

export const auditPrincipal = pgEnum("audit_principal", [
	"staff",
	"legacy",
	"system",
	"unattributed",
]);
export const auditVia = pgEnum("audit_via", ["device", "grant"]);
export const auditOp = pgEnum("audit_op", ["insert", "update", "delete"]);

export const auditEvents = pgTable(
	"audit_events",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		txId: bigint({ mode: "number" }).notNull().default(sql`txid_current()`),
		principal: auditPrincipal().notNull(),
		staffId: uuid(),
		staffName: text(),
		staffRole: staffRole(),
		viaKind: auditVia(),
		viaId: text(),
		viaName: text(),
		systemName: text(),
		operation: text(),
		tableName: text().notNull(),
		op: auditOp().notNull(),
		resource: jsonb().notNull(),
		changedFields: text().array(),
	},
	(t) => [
		index("audit_events_at_idx").on(t.at),
		index("audit_events_staff_idx").on(t.staffId),
		index("audit_events_resource_idx").on(t.tableName, t.resource),
		check(
			"audit_events_principal_shape",
			sql`case ${t.principal}
				when 'staff' then ${t.staffId} is not null and ${t.staffName} is not null and ${t.staffRole} is not null and ${t.viaKind} is not null and ${t.systemName} is null
				when 'legacy' then ${t.staffId} is null and ${t.staffRole} is null and ${t.viaKind} is not null and ${t.systemName} is null
				when 'system' then ${t.staffId} is null and ${t.staffRole} is null and ${t.viaKind} is null and ${t.systemName} is not null
				else ${t.staffId} is null and ${t.staffRole} is null and ${t.viaKind} is null and ${t.systemName} is null
			end`,
		),
		check(
			"audit_events_via_shape",
			sql`(${t.viaKind} is null) = (${t.viaId} is null) and (${t.viaKind} is null) = (${t.viaName} is null)`,
		),
	],
);
