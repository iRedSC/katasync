import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	damagePhotoUploads,
	products,
	purchaseOrderAmendments,
	purchaseOrderDamagePhotos,
	purchaseOrderDamageReports,
	purchaseOrderDamages,
	purchaseOrderLines,
} from "#/db/schema";
import { postMovements, undoBatch } from "#/inventory/ledger";
import {
	EMAIL_PHOTO_BYTES,
	MAX_PHOTO_BYTES,
	MAX_PHOTOS,
} from "#/purchasing/damage-limits";
import {
	damagedOf,
	lockOrder,
	PurchaseOrderError,
	poName,
	receivedOf,
	reopen,
} from "#/purchasing/orders";

// Damage found in a delivery. Recording it takes the items off the shelf at
// once, since they can't be sold; a report later tells the supplier and asks,
// per item, for credit or a replacement. A replacement makes the line expect
// that many again, so the PO waits for them.

export type Remedy = (typeof purchaseOrderDamages.$inferSelect)["remedy"] &
	string;

const UPLOAD_LINK_MINUTES = 30;

// A line and its PO, locked, while the PO is on order. The line is read
// again once the PO is locked: a change that held the lock may have changed
// or removed it.
async function lineOf(tx: Db, lineId: number) {
	const [found] = await tx
		.select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
		.from(purchaseOrderLines)
		.where(eq(purchaseOrderLines.id, lineId));
	if (!found) throw new PurchaseOrderError("That line doesn't exist");
	const po = await lockOrder(tx, found.purchaseOrderId, ["sent", "closed"]);
	const [line] = await tx
		.select()
		.from(purchaseOrderLines)
		.where(eq(purchaseOrderLines.id, lineId));
	if (!line) throw new PurchaseOrderError("That line doesn't exist");
	return { line, po };
}

// The damage and its PO, locked, refusing once it's been reported: the
// supplier already has it as it was. Read again once the PO is locked, so a
// report sent meanwhile is seen.
async function unreported(tx: Db, damageId: number) {
	const read = () =>
		tx
			.select({
				id: purchaseOrderDamages.id,
				lineId: purchaseOrderDamages.lineId,
				batchId: purchaseOrderDamages.batchId,
				reportId: purchaseOrderDamages.reportId,
				purchaseOrderId: purchaseOrderLines.purchaseOrderId,
			})
			.from(purchaseOrderDamages)
			.innerJoin(
				purchaseOrderLines,
				eq(purchaseOrderLines.id, purchaseOrderDamages.lineId),
			)
			.where(eq(purchaseOrderDamages.id, damageId));
	const [found] = await read();
	if (!found) throw new PurchaseOrderError("That damage doesn't exist");
	await lockOrder(tx, found.purchaseOrderId, ["sent", "closed"]);
	const [damage] = await read();
	if (!damage) throw new PurchaseOrderError("That damage doesn't exist");
	if (damage.reportId !== null)
		throw new PurchaseOrderError(
			"That damage was already reported to the supplier",
		);
	return damage;
}

// Records items of a line that arrived damaged, in single items, and takes
// them off the shelf. They can't add up to more than arrived.
export async function recordDamage(
	db: Db,
	input: { lineId: number; quantity: number; description: string },
) {
	if (!Number.isInteger(input.quantity) || input.quantity <= 0)
		throw new PurchaseOrderError(
			`Quantity must be a positive whole number, got ${input.quantity}`,
		);
	const description = input.description.trim();
	if (!description) throw new PurchaseOrderError("Say what's wrong with them");
	return db.transaction(async (tx) => {
		const { line, po } = await lineOf(tx, input.lineId);
		const arrived = (await receivedOf(tx, line.id)) * line.packSize;
		const already = await damagedOf(tx, line.id);
		if (already + input.quantity > arrived)
			throw new PurchaseOrderError(
				already > 0
					? `Only ${arrived} arrived and ${already} are already damaged`
					: `Only ${arrived} arrived`,
			);
		const { batchId } = await postMovements(tx, {
			reference: poName(po.id),
			note: `Damaged: ${description}`,
			lines: [
				{
					productId: line.productId,
					locationId: po.locationId,
					delta: -input.quantity,
					reason: "adjustment",
				},
			],
		});
		const [damage] = await tx
			.insert(purchaseOrderDamages)
			.values({
				lineId: line.id,
				quantity: input.quantity,
				description,
				batchId,
			})
			.returning({ id: purchaseOrderDamages.id });
		return { damageId: damage.id };
	});
}

// Takes back damage recorded by mistake: the items go back on the shelf and
// its photos go with it. Not once it's been reported.
export async function removeDamage(db: Db, damageId: number) {
	return db.transaction(async (tx) => {
		const damage = await unreported(tx, damageId);
		await undoBatch(tx, damage.batchId);
		await tx
			.delete(purchaseOrderDamages)
			.where(eq(purchaseOrderDamages.id, damage.id));
	});
}

// The image type of an upload, from its first bytes; null when it isn't one
// we keep. The type a browser or client claims isn't trusted.
export function imageType(bytes: Uint8Array) {
	const at = (i: number, ...b: number[]) =>
		b.every((x, j) => bytes[i + j] === x);
	if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
		return "image/webp";
	return null;
}

export async function addDamagePhoto(
	db: Db,
	input: { damageId: number; bytes: Uint8Array },
) {
	const contentType = imageType(input.bytes);
	if (!contentType)
		throw new PurchaseOrderError("Photos must be JPEG, PNG, or WebP");
	if (input.bytes.length > MAX_PHOTO_BYTES)
		throw new PurchaseOrderError(
			`Photos can be up to ${MAX_PHOTO_BYTES / 1_000_000} MB; this one is ${(input.bytes.length / 1_000_000).toFixed(1)} MB`,
		);
	return db.transaction(async (tx) => {
		const damage = await unreported(tx, input.damageId);
		// A photo the damage already has, byte for byte, is that photo: a retry after
		// a lost response gets its id back rather than a second copy.
		const [same] = await tx
			.select({ id: purchaseOrderDamagePhotos.id })
			.from(purchaseOrderDamagePhotos)
			.where(
				and(
					eq(purchaseOrderDamagePhotos.damageId, damage.id),
					eq(purchaseOrderDamagePhotos.data, Buffer.from(input.bytes)),
				),
			)
			.limit(1);
		if (same) return { photoId: same.id };
		const [{ count }] = await tx
			.select({ count: sql<number>`count(*)::int` })
			.from(purchaseOrderDamagePhotos)
			.where(eq(purchaseOrderDamagePhotos.damageId, damage.id));
		if (count >= MAX_PHOTOS)
			throw new PurchaseOrderError(`A damage can have ${MAX_PHOTOS} photos`);
		const [photo] = await tx
			.insert(purchaseOrderDamagePhotos)
			.values({
				damageId: damage.id,
				contentType,
				data: Buffer.from(input.bytes),
			})
			.returning({ id: purchaseOrderDamagePhotos.id });
		return { photoId: photo.id };
	});
}

export async function removeDamagePhoto(db: Db, photoId: number) {
	return db.transaction(async (tx) => {
		const [photo] = await tx
			.select({ damageId: purchaseOrderDamagePhotos.damageId })
			.from(purchaseOrderDamagePhotos)
			.where(eq(purchaseOrderDamagePhotos.id, photoId));
		if (!photo) throw new PurchaseOrderError("That photo doesn't exist");
		await unreported(tx, photo.damageId);
		await tx
			.delete(purchaseOrderDamagePhotos)
			.where(eq(purchaseOrderDamagePhotos.id, photoId));
	});
}

export async function damagePhoto(db: Db, photoId: number) {
	const [photo] = await db
		.select({
			contentType: purchaseOrderDamagePhotos.contentType,
			data: purchaseOrderDamagePhotos.data,
		})
		.from(purchaseOrderDamagePhotos)
		.where(eq(purchaseOrderDamagePhotos.id, photoId));
	return photo ?? null;
}

const hash = (token: string) =>
	createHash("sha256").update(token).digest("base64url");

// A link that takes photos of one damage without a session, for Claude to
// upload from its shell. It works for a while, for any number of photos.
export async function createPhotoUploadLink(
	db: Db,
	damageId: number,
	now = new Date(),
) {
	return db.transaction(async (tx) => {
		const damage = await unreported(tx, damageId);
		const token = randomBytes(32).toString("base64url");
		const expiresAt = new Date(now.getTime() + UPLOAD_LINK_MINUTES * 60_000);
		await tx
			.insert(damagePhotoUploads)
			.values({ tokenHash: hash(token), damageId: damage.id, expiresAt });
		return { token, expiresAt };
	});
}

// The damage an upload link is for, or null when it's unknown or expired.
export async function damageForUploadLink(
	db: Db,
	token: string,
	now = new Date(),
) {
	const [link] = await db
		.select({ damageId: damagePhotoUploads.damageId })
		.from(damagePhotoUploads)
		.where(
			and(
				eq(damagePhotoUploads.tokenHash, hash(token)),
				gt(damagePhotoUploads.expiresAt, now),
			),
		);
	return link?.damageId ?? null;
}

// Every damage on a PO, oldest first, with its photos' ids and, once
// reported, what was asked for and when it went.
export async function damagesOf(db: Db, purchaseOrderId: number) {
	const rows = await db
		.select({
			id: purchaseOrderDamages.id,
			lineId: purchaseOrderDamages.lineId,
			productId: purchaseOrderLines.productId,
			sku: products.sku,
			name: products.name,
			variantName: products.variantName,
			unit: purchaseOrderLines.unit,
			packSize: purchaseOrderLines.packSize,
			quantity: purchaseOrderDamages.quantity,
			description: purchaseOrderDamages.description,
			remedy: purchaseOrderDamages.remedy,
			reportedAt: purchaseOrderDamageReports.sentAt,
			reportedTo: purchaseOrderDamageReports.sentTo,
			createdAt: purchaseOrderDamages.createdAt,
		})
		.from(purchaseOrderDamages)
		.innerJoin(
			purchaseOrderLines,
			eq(purchaseOrderLines.id, purchaseOrderDamages.lineId),
		)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.leftJoin(
			purchaseOrderDamageReports,
			eq(purchaseOrderDamageReports.id, purchaseOrderDamages.reportId),
		)
		.where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
		.orderBy(asc(purchaseOrderDamages.createdAt), asc(purchaseOrderDamages.id));
	const photos =
		rows.length === 0
			? []
			: await db
					.select({
						id: purchaseOrderDamagePhotos.id,
						damageId: purchaseOrderDamagePhotos.damageId,
						bytes: sql<number>`octet_length(${purchaseOrderDamagePhotos.data})::int`,
					})
					.from(purchaseOrderDamagePhotos)
					.where(
						inArray(
							purchaseOrderDamagePhotos.damageId,
							rows.map((r) => r.id),
						),
					)
					.orderBy(asc(purchaseOrderDamagePhotos.id));
	return rows.map((r) => ({
		...r,
		photoIds: photos.filter((p) => p.damageId === r.id).map((p) => p.id),
		// What its photos add to a report's email.
		photoBytes: photos
			.filter((p) => p.damageId === r.id)
			.reduce((n, p) => n + p.bytes, 0),
		// A replacement has to be whole units: the PO can't expect half a case.
		replaceable: r.quantity % r.packSize === 0,
	}));
}

export type DamageReportItem = {
	sku: string;
	name: string;
	quantity: number;
	description: string;
	remedy: Remedy;
	photos: { contentType: string; data: Buffer }[];
};

// Sends every damage on the PO not yet reported, each with what to ask for.
// `deliver` emails the report with the PO locked and returns who it went to;
// if it fails, nothing is recorded. A replacement makes its line expect that
// many more, and reopens a closed PO.
export async function sendDamageReport(
	db: Db,
	input: {
		purchaseOrderId: number;
		remedies: { damageId: number; remedy: Remedy }[];
		deliver: (tx: Db, items: DamageReportItem[]) => Promise<string>;
	},
) {
	return db.transaction(async (tx) => {
		const po = await lockOrder(tx, input.purchaseOrderId, ["sent", "closed"]);
		const pending = (await damagesOf(tx, po.id)).filter(
			(d) => d.reportedAt === null,
		);
		if (pending.length === 0)
			throw new PurchaseOrderError(`${poName(po.id)} has no damage to report`);
		const chosen = new Map(input.remedies.map((r) => [r.damageId, r.remedy]));
		// The page may be behind: damage added or taken back since it loaded.
		if (
			chosen.size !== input.remedies.length ||
			chosen.size !== pending.length ||
			pending.some((d) => !chosen.has(d.id))
		)
			throw new PurchaseOrderError(
				"The damage on this PO changed; reload and choose again",
			);
		for (const d of pending)
			if (chosen.get(d.id) === "replacement" && !d.replaceable)
				throw new PurchaseOrderError(
					`${d.quantity} × ${d.sku} isn't a whole ${d.unit}; ask for credit`,
				);

		const photos = await tx
			.select()
			.from(purchaseOrderDamagePhotos)
			.where(
				inArray(
					purchaseOrderDamagePhotos.damageId,
					pending.map((d) => d.id),
				),
			)
			.orderBy(asc(purchaseOrderDamagePhotos.id));
		const bytes = photos.reduce((n, p) => n + p.data.length, 0);
		if (bytes > EMAIL_PHOTO_BYTES)
			throw new PurchaseOrderError(
				`The photos come to ${Math.round(bytes / 1_000_000)} MB, more than one email takes; remove some`,
			);

		const sentTo = await input.deliver(
			tx,
			pending.map((d) => ({
				sku: d.sku,
				name: d.variantName ? `${d.name} (${d.variantName})` : d.name,
				quantity: d.quantity,
				description: d.description,
				remedy: chosen.get(d.id) as Remedy,
				photos: photos
					.filter((p) => p.damageId === d.id)
					.map((p) => ({ contentType: p.contentType, data: p.data })),
			})),
		);

		const [report] = await tx
			.insert(purchaseOrderDamageReports)
			.values({ purchaseOrderId: po.id, sentTo })
			.returning({ id: purchaseOrderDamageReports.id });
		for (const d of pending) {
			const remedy = chosen.get(d.id) as Remedy;
			await tx
				.update(purchaseOrderDamages)
				.set({ reportId: report.id, remedy })
				.where(
					and(
						eq(purchaseOrderDamages.id, d.id),
						isNull(purchaseOrderDamages.reportId),
					),
				);
		}
		// Replacements, a line at a time: two damages on one line add up.
		const replacing = new Map<number, number>();
		for (const d of pending)
			if (chosen.get(d.id) === "replacement")
				replacing.set(
					d.lineId,
					(replacing.get(d.lineId) ?? 0) + d.quantity / d.packSize,
				);
		for (const [lineId, more] of replacing) {
			const [line] = await tx
				.update(purchaseOrderLines)
				.set({ quantity: sql`${purchaseOrderLines.quantity} + ${more}` })
				.where(eq(purchaseOrderLines.id, lineId))
				.returning({
					productId: purchaseOrderLines.productId,
					quantity: purchaseOrderLines.quantity,
				});
			await tx.insert(purchaseOrderAmendments).values({
				purchaseOrderId: po.id,
				productId: line.productId,
				kind: "quantity",
				quantityBefore: line.quantity - more,
				quantityAfter: line.quantity,
			});
		}
		if (replacing.size > 0 && po.status === "closed") await reopen(tx, po.id);
		return { reportId: report.id, sentTo, items: pending.length };
	});
}

// The photos in an upload: each file of a multipart form (curl -F
// photo=@a.jpg -F photo=@b.jpg), or the whole body (curl --data-binary @a.jpg).
export async function photosFromRequest(request: Request) {
	const type = request.headers.get("content-type") ?? "";
	if (type.startsWith("multipart/form-data")) {
		const form = await request.formData();
		const files = [...form.values()].filter(
			(v): v is File => typeof v !== "string",
		);
		return Promise.all(
			files.map(async (f) => new Uint8Array(await f.arrayBuffer())),
		);
	}
	const body = new Uint8Array(await request.arrayBuffer());
	return body.length > 0 ? [body] : [];
}

// Saves an upload's photos to a damage, one at a time, and answers with
// their ids, or with why the first bad one was refused (those before it
// stay).
export async function uploadResponse(
	db: Db,
	damageId: number,
	request: Request,
) {
	const photos = await photosFromRequest(request).catch(() => null);
	if (!photos)
		return Response.json(
			{ error: "Couldn't read the upload" },
			{ status: 400 },
		);
	if (photos.length === 0)
		return Response.json({ error: "No photo in the upload" }, { status: 400 });
	const photoIds: number[] = [];
	for (const bytes of photos) {
		try {
			photoIds.push((await addDamagePhoto(db, { damageId, bytes })).photoId);
		} catch (err) {
			if (!(err instanceof PurchaseOrderError)) throw err;
			return Response.json({ error: err.message, photoIds }, { status: 422 });
		}
	}
	return Response.json({ photoIds });
}
