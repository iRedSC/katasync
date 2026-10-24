import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "#/auth/actor";
import { standingOfSession } from "#/auth/principal";
import { createSession, hashToken } from "#/auth/sessions";
import { addPerson } from "#/auth/staff.fixtures";
import type { Db } from "#/db/client";
import { auditEvents } from "#/db/identity-schema";
import * as schema from "#/db/schema";
import { addPoFile } from "#/purchasing/files";
import { createTestDb } from "#/test/db";
import { AUDIT_SETTING, audited } from "./audited-db";
import { runAs } from "./context";
import { requestOperation } from "./request-operation";

let raw: Db;
let db: Db;
beforeEach(async () => {
	raw = await createTestDb();
	db = audited(raw);
});

const events = () => raw.select().from(auditEvents).orderBy(auditEvents.id);
const setting = async () => {
	const { rows } = (await raw.execute(
		sql`select coalesce(current_setting(${AUDIT_SETTING}, true), '') as v`,
	)) as unknown as { rows: { v: string }[] };
	return rows[0].v;
};
const addProduct = (d: Db, sku: string) =>
	d
		.insert(schema.products)
		.values({ sku, name: sku, kind: "simple" })
		.returning({ id: schema.products.id });

describe("audited writes", () => {
	test("never records a suggested-PO upload bearer credential", async () => {
		const [supplier] = await raw
			.insert(schema.suppliers)
			.values({ code: "UPLOAD", name: "Upload supplier" })
			.returning();
		const [location] = await raw
			.insert(schema.locations)
			.values({ name: "Upload dock", kind: "owned" })
			.returning();
		const [po] = await raw
			.insert(schema.purchaseOrders)
			.values({
				supplierId: supplier.id,
				locationId: location.id,
				status: "suggested",
			})
			.returning();
		const owner = await addPerson(raw, "Uploader", "owner");
		const token = "upload-bearer-must-never-be-audited";
		const operation = requestOperation(
			new Request(
				`https://example.test/api/uploads/po-file/${token}?also=${token}`,
				{ method: "POST" },
			),
		);
		await runAs(owner, operation, () =>
			addPoFile(db, {
				purchaseOrderId: po.id,
				filename: "invoice.txt",
				contentType: "text/plain",
				data: new TextEncoder().encode("invoice"),
				addedBy: "staff",
			}),
		);
		const rows = await events();
		expect(rows).toContainEqual(
			expect.objectContaining({
				tableName: "purchase_orders",
				op: "update",
				operation: "POST /api/uploads/po-file/$token",
			}),
		);
		expect(JSON.stringify(rows)).not.toContain(token);
		expect(
			requestOperation(new Request(`https://example.test/unknown/${token}`)),
		).toBe("GET /request");
	});

	test("credit a named person in the same transaction", async () => {
		const sam = await addPerson(raw, "Sam", "operator", ["sam-phone"]);
		const [p] = await runAs(sam, "POST /products", () =>
			db.transaction(async (tx) => addProduct(tx, "WRENCH")),
		);
		const rows = await events();
		const product = rows.filter((r) => r.tableName === "products");
		expect(product).toEqual([
			expect.objectContaining({
				principal: "staff",
				staffId: sam.staffId,
				staffName: "Sam",
				staffRole: "operator",
				viaKind: "device",
				viaId: "sam-phone",
				operation: "POST /products",
				op: "insert",
				resource: { id: p.id },
				changedFields: null,
			}),
		]);
	});

	test("roll back with the change they describe", async () => {
		const sam = await addPerson(raw, "Sam", "operator");
		const before = (await events()).length;
		await expect(
			runAs(sam, null, () =>
				db.transaction(async (tx) => {
					await addProduct(tx, "WRENCH");
					throw new Error("changed my mind");
				}),
			),
		).rejects.toThrow("changed my mind");
		expect(await raw.select().from(schema.products)).toHaveLength(0);
		expect(await events()).toHaveLength(before);
	});

	test("outside a transaction record field names, not values", async () => {
		const [p] = await addProduct(raw, "WRENCH");
		const owner = await addPerson(raw, "Robin", "owner");
		await runAs(owner, null, () =>
			db
				.update(schema.products)
				.set({ name: "Secret new name" })
				.where(eq(schema.products.id, p.id)),
		);
		const [update] = (await events()).filter((r) => r.op === "update");
		expect(update).toMatchObject({
			principal: "staff",
			staffName: "Robin",
			tableName: "products",
			resource: { id: p.id },
			changedFields: ["name"],
		});
		expect(JSON.stringify(update)).not.toContain("Secret new name");
	});

	test("say so when nothing set who did them", async () => {
		await addProduct(db, "WRENCH");
		expect((await events()).at(-1)).toMatchObject({
			principal: "unattributed",
			staffId: null,
			systemName: null,
		});
	});

	test("credit system jobs and unassigned devices to no person", async () => {
		await runAs({ kind: "system", name: "cron" }, null, () =>
			addProduct(db, "A"),
		);
		const legacy: Actor = {
			kind: "legacy",
			via: { kind: "device", passkeyId: "old", name: "Old iPad" },
		};
		await runAs(legacy, null, () => addProduct(db, "B"));
		const [cron, old] = (await events()).filter(
			(r) => r.tableName === "products",
		);
		expect(cron).toMatchObject({
			principal: "system",
			systemName: "cron",
			staffName: null,
		});
		expect(old).toMatchObject({
			principal: "legacy",
			viaName: "Old iPad",
			staffName: null,
		});
	});

	test("leave nothing on the connection afterwards", async () => {
		const sam = await addPerson(raw, "Sam", "operator");
		await runAs(sam, null, () => addProduct(db, "A"));
		await runAs(sam, null, () => db.transaction((tx) => addProduct(tx, "B")));
		expect(await setting()).toBe("");
		await addProduct(db, "C");
		expect((await events()).at(-1)?.principal).toBe("unattributed");
	});

	test("keep concurrent requests' actors apart", async () => {
		const sam = await addPerson(raw, "Sam", "operator");
		const pat = await addPerson(raw, "Pat", "owner");
		await Promise.all(
			[sam, pat, sam, pat].map((actor, i) =>
				runAs(actor, `req-${i}`, () =>
					db.transaction(async (tx) => {
						await new Promise((r) => setTimeout(r, 2));
						return addProduct(tx, `SKU-${i}`);
					}),
				),
			),
		);
		const rows = (await events()).filter((r) => r.tableName === "products");
		for (const row of rows) {
			const i = Number(row.operation?.slice(4));
			expect(row.staffName).toBe(i % 2 === 0 ? "Sam" : "Pat");
		}
		expect(rows).toHaveLength(4);
	});

	test("never hold a session's secret", async () => {
		const sam = await addPerson(raw, "Sam", "operator", ["sam-phone"]);
		const token = await createSession(raw, "sam-phone");
		const standing = await standingOfSession(raw, token);
		if (standing.kind !== "signed-in") throw new Error("not signed in");
		expect(standing.actor).toMatchObject({
			kind: "staff",
			staffId: sam.staffId,
		});
		await runAs(standing.actor, null, () => addProduct(db, "A"));
		const dump = JSON.stringify(await events());
		expect(dump).not.toContain(token);
		expect(dump).not.toContain(hashToken(token));
	});

	test("can't be edited or deleted", async () => {
		await addProduct(db, "A");
		const immutable = {
			cause: expect.objectContaining({
				message: expect.stringMatching(/append-only/),
			}),
		};
		await expect(raw.delete(auditEvents)).rejects.toMatchObject(immutable);
		await expect(
			raw.update(auditEvents).set({ staffName: "Someone else" }),
		).rejects.toMatchObject(immutable);
		await expect(raw.execute(sql`truncate audit_events`)).rejects.toMatchObject(
			immutable,
		);
	});
});
