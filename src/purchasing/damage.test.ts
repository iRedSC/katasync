import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import {
	addDamagePhoto,
	createPhotoUploadLink,
	damageForUploadLink,
	damagesOf,
	imageType,
	recordDamage,
	removeDamage,
	sendDamageReport,
} from "./damage";
import { receive, undoReceipt } from "./orders";

let db: Db;
let poId: number;
let caseLine: number;
let eachLine: number;
let blade: number;

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

async function onHand(productId: number) {
	const [level] = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, productId));
	return level?.onHand ?? 0;
}

async function status() {
	const [po] = await db
		.select({ status: schema.purchaseOrders.status })
		.from(schema.purchaseOrders)
		.where(eq(schema.purchaseOrders.id, poId));
	return po.status;
}

beforeEach(async () => {
	db = await createTestDb();
	blade = await createProduct(db, "BLADE", "simple");
	const knife = await createProduct(db, "KNIFE", "simple");
	const [supplier] = await db
		.insert(schema.suppliers)
		.values({ code: "CANAM", name: "CanAm", email: "orders@canam.test" })
		.returning();
	const [location] = await db
		.insert(schema.locations)
		.values({ name: "Shop", kind: "owned" })
		.returning();
	const [po] = await db
		.insert(schema.purchaseOrders)
		.values({
			supplierId: supplier.id,
			locationId: location.id,
			status: "sent",
		})
		.returning();
	poId = po.id;
	const lines = await db
		.insert(schema.purchaseOrderLines)
		.values([
			{
				purchaseOrderId: po.id,
				productId: blade,
				unit: "CASE",
				packSize: 12,
				supplierCount: 12,
				quantity: 1,
			},
			{
				purchaseOrderId: po.id,
				productId: knife,
				supplierCount: 1,
				quantity: 3,
			},
		])
		.returning();
	caseLine = lines[0].id;
	eachLine = lines[1].id;
});

test("takes damaged items off the shelf, never more than arrived", async () => {
	await receive(db, { lineId: caseLine, quantity: 1 });
	await recordDamage(db, {
		kind: "damaged",
		lineId: caseLine,
		quantity: 2,
		description: " snapped ",
	});
	expect(await onHand(blade)).toBe(10);
	await expect(
		recordDamage(db, {
			kind: "damaged",
			lineId: caseLine,
			quantity: 11,
			description: "x",
		}),
	).rejects.toThrow("Only 12 arrived and 2 are already damaged");
	await expect(
		recordDamage(db, {
			kind: "damaged",
			lineId: eachLine,
			quantity: 1,
			description: "x",
		}),
	).rejects.toThrow("Only 0 arrived");
	await expect(
		recordDamage(db, {
			kind: "damaged",
			lineId: caseLine,
			quantity: 1,
			description: "  ",
		}),
	).rejects.toThrow();
	const [d] = await damagesOf(db, poId);
	expect(d).toMatchObject({
		quantity: 2,
		description: "snapped",
		replaceable: false,
	});
});

test("a receipt can't be undone from under its damage, until the damage is taken back", async () => {
	const { receiptId } = await receive(db, { lineId: caseLine, quantity: 1 });
	const { damageId } = await recordDamage(db, {
		kind: "damaged",
		lineId: caseLine,
		quantity: 2,
		description: "snapped",
	});
	await addDamagePhoto(db, { damageId, bytes: jpeg });
	await expect(undoReceipt(db, receiptId)).rejects.toThrow("damaged");
	await removeDamage(db, damageId);
	expect(await onHand(blade)).toBe(12);
	expect(await db.select().from(schema.purchaseOrderDamagePhotos)).toEqual([]);
	await undoReceipt(db, receiptId);
	expect(await onHand(blade)).toBe(0);
});

test("knows photos by their bytes, not what they claim", async () => {
	expect(imageType(jpeg)).toBe("image/jpeg");
	expect(imageType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
	await receive(db, { lineId: eachLine, quantity: 1 });
	const { damageId } = await recordDamage(db, {
		kind: "damaged",
		lineId: eachLine,
		quantity: 1,
		description: "bent",
	});
	await expect(
		addDamagePhoto(db, { damageId, bytes: new Uint8Array([1, 2, 3]) }),
	).rejects.toThrow("JPEG, PNG, or WebP");
});

test("upload links work until they expire", async () => {
	await receive(db, { lineId: eachLine, quantity: 1 });
	const { damageId } = await recordDamage(db, {
		kind: "damaged",
		lineId: eachLine,
		quantity: 1,
		description: "bent",
	});
	const now = new Date("2026-10-18T12:00:00Z");
	const { token } = await createPhotoUploadLink(db, damageId, now);
	expect(await damageForUploadLink(db, token, now)).toBe(damageId);
	expect(
		await damageForUploadLink(db, token, new Date("2026-10-18T13:00:00Z")),
	).toBeNull();
	expect(await damageForUploadLink(db, "made-up", now)).toBeNull();
});

test("sends every unreported damage once; a replacement makes the line wait again", async () => {
	await receive(db, { lineId: caseLine, quantity: 1 });
	await receive(db, { lineId: eachLine, quantity: 3 });
	expect(await status()).toBe("closed");
	const whole = await recordDamage(db, {
		kind: "damaged",
		lineId: caseLine,
		quantity: 12,
		description: "crushed case",
	});
	const one = await recordDamage(db, {
		kind: "damaged",
		lineId: eachLine,
		quantity: 1,
		description: "bent tip",
	});
	await addDamagePhoto(db, { damageId: whole.damageId, bytes: jpeg });

	// A damage the page didn't know about is refused, as is a replacement
	// that isn't whole units.
	await expect(
		sendDamageReport(db, {
			purchaseOrderId: poId,
			remedies: [{ damageId: whole.damageId, remedy: "credit" }],
			deliver: async () => "x",
		}),
	).rejects.toThrow("changed");

	// A failed email records nothing.
	await expect(
		sendDamageReport(db, {
			purchaseOrderId: poId,
			remedies: [
				{ damageId: whole.damageId, remedy: "replacement" },
				{ damageId: one.damageId, remedy: "credit" },
			],
			deliver: async () => {
				throw new Error("Resend is down");
			},
		}),
	).rejects.toThrow("Resend is down");
	expect((await damagesOf(db, poId)).every((d) => d.reportedAt === null)).toBe(
		true,
	);

	let sent: Parameters<Parameters<typeof sendDamageReport>[1]["deliver"]>[1] =
		[];
	await sendDamageReport(db, {
		purchaseOrderId: poId,
		remedies: [
			{ damageId: whole.damageId, remedy: "replacement" },
			{ damageId: one.damageId, remedy: "credit" },
		],
		deliver: async (_tx, items) => {
			sent = items;
			return "orders@canam.test";
		},
	});
	expect(sent.map((i) => [i.sku, i.remedy, i.photos.length])).toEqual([
		["BLADE", "replacement", 1],
		["KNIFE", "credit", 0],
	]);
	const [line] = await db
		.select({ quantity: schema.purchaseOrderLines.quantity })
		.from(schema.purchaseOrderLines)
		.where(eq(schema.purchaseOrderLines.id, caseLine));
	expect(line.quantity).toBe(2);
	expect(await status()).toBe("sent");

	// Reported damage stays as sent.
	await expect(removeDamage(db, one.damageId)).rejects.toThrow(
		"already reported",
	);
	await expect(
		addDamagePhoto(db, { damageId: one.damageId, bytes: jpeg }),
	).rejects.toThrow("already reported");
	await expect(
		sendDamageReport(db, {
			purchaseOrderId: poId,
			remedies: [],
			deliver: async () => "x",
		}),
	).rejects.toThrow("no damage to report");
});

test("missing items come off the shelf without saying what's wrong, and the report says they're missing", async () => {
	await receive(db, { lineId: caseLine, quantity: 1 });
	await recordDamage(db, { lineId: caseLine, quantity: 2, kind: "missing" });
	expect(await onHand(blade)).toBe(10);
	await expect(
		recordDamage(db, {
			lineId: caseLine,
			quantity: 1,
			kind: "damaged",
			description: " ",
		}),
	).rejects.toThrow("Say what's wrong");
	const [d] = await damagesOf(db, poId);
	expect(d).toMatchObject({ kind: "missing", description: null });
	let sent: { kind: string; description: string | null }[] = [];
	await sendDamageReport(db, {
		purchaseOrderId: poId,
		remedies: [{ damageId: d.id, remedy: "credit" }],
		deliver: async (_tx, items) => {
			sent = items;
			return "orders@canam.test";
		},
	});
	expect(sent).toMatchObject([{ kind: "missing", description: null }]);
});
