import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import { poFileUploads, purchaseOrderFiles } from "#/db/schema";
import { isPdf, pdfText } from "#/purchasing/inbox/pdf-text";
import {
	lockForEdit,
	lockOrder,
	PurchaseOrderError,
} from "#/purchasing/orders";
import { MAX_PO_FILE_BYTES } from "./file-limits";

// Files put on a PO itself, by staff from its page or by Claude. Any PO but
// a suggested one takes them; adding one to a suggested PO saves it as a
// draft, as any first change does. Removing a file only marks it, so Undo
// can put it back.

const UPLOAD_LINK_MINUTES = 30;
const ANY = ["draft", "sent", "closed", "cancelled"] as const;

export type PoFileSource = "staff" | "claude";

// What a file is called and what it is, from what the upload says. Browsers
// send no type for some files (.eml on Windows), so the name decides then.
function typeOf(contentType: string, filename: string) {
	const given = contentType.split(";")[0].trim().toLowerCase();
	if (given && given !== "application/octet-stream") return given;
	if (/\.pdf$/i.test(filename)) return "application/pdf";
	if (/\.eml$/i.test(filename)) return "message/rfc822";
	if (/\.png$/i.test(filename)) return "image/png";
	if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
	return "application/octet-stream";
}

const named = (filename: string) =>
	filename.replace(/[/\\]/g, "_").trim().slice(0, 200);

export async function addPoFile(
	db: Db,
	input: {
		purchaseOrderId: number;
		filename: string;
		contentType: string;
		data: Uint8Array;
		addedBy: PoFileSource;
	},
) {
	const filename = named(input.filename);
	if (!filename) throw new PurchaseOrderError("The file needs a name");
	if (input.data.length === 0)
		throw new PurchaseOrderError(`${filename} is empty`);
	if (input.data.length > MAX_PO_FILE_BYTES)
		throw new PurchaseOrderError(
			`${filename} is ${(input.data.length / 1e6).toFixed(1)} MB; a PO's files can be up to ${MAX_PO_FILE_BYTES / 1e6} MB`,
		);
	const data = Buffer.from(input.data);
	const contentType = typeOf(input.contentType, filename);
	// Read before the lock, so a slow PDF doesn't hold the PO.
	const text = isPdf(contentType, filename) ? await pdfText(data) : null;
	return db.transaction(async (tx) => {
		await lockForEdit(tx, input.purchaseOrderId, [...ANY]);
		const [row] = await tx
			.insert(purchaseOrderFiles)
			.values({
				purchaseOrderId: input.purchaseOrderId,
				filename,
				contentType,
				size: data.length,
				data,
				text,
				addedBy: input.addedBy,
			})
			.returning({ id: purchaseOrderFiles.id });
		return { id: row.id, filename, contentType, size: data.length };
	});
}

// Takes a file off its PO, or with removed false puts it back.
export async function setPoFileRemoved(db: Db, id: number, removed = true) {
	const [row] = await db
		.update(purchaseOrderFiles)
		.set({ removedAt: removed ? new Date() : null })
		.where(
			and(
				eq(purchaseOrderFiles.id, id),
				removed
					? isNull(purchaseOrderFiles.removedAt)
					: isNotNull(purchaseOrderFiles.removedAt),
			),
		)
		.returning({
			id: purchaseOrderFiles.id,
			purchaseOrderId: purchaseOrderFiles.purchaseOrderId,
			filename: purchaseOrderFiles.filename,
		});
	if (!row)
		throw new PurchaseOrderError(
			removed ? "That file is already off the PO" : "That file is on its PO",
		);
	return row;
}

// A PO's files, newest first, without their bytes.
export async function poFilesOf(db: Db, purchaseOrderId: number) {
	return db
		.select({
			id: purchaseOrderFiles.id,
			filename: purchaseOrderFiles.filename,
			contentType: purchaseOrderFiles.contentType,
			size: purchaseOrderFiles.size,
			addedBy: purchaseOrderFiles.addedBy,
			createdAt: purchaseOrderFiles.createdAt,
		})
		.from(purchaseOrderFiles)
		.where(
			and(
				eq(purchaseOrderFiles.purchaseOrderId, purchaseOrderId),
				isNull(purchaseOrderFiles.removedAt),
			),
		)
		.orderBy(desc(purchaseOrderFiles.id));
}

// One file with its bytes, removed ones too (an open tab keeps working).
export async function poFile(db: Db, id: number) {
	const [file] = await db
		.select()
		.from(purchaseOrderFiles)
		.where(eq(purchaseOrderFiles.id, id));
	return file ?? null;
}

const hash = (token: string) =>
	createHash("sha256").update(token).digest("base64url");

// A link that takes files for one PO without a session, for Claude to upload
// from its shell. It works for a while, for any number of files.
export async function createFileUploadLink(
	db: Db,
	purchaseOrderId: number,
	now = new Date(),
) {
	return db.transaction(async (tx) => {
		const po = await lockOrder(tx, purchaseOrderId, [...ANY, "suggested"]);
		const token = randomBytes(32).toString("base64url");
		const expiresAt = new Date(now.getTime() + UPLOAD_LINK_MINUTES * 60_000);
		await tx
			.insert(poFileUploads)
			.values({ tokenHash: hash(token), purchaseOrderId: po.id, expiresAt });
		return { token, expiresAt };
	});
}

// The PO an upload link is for, or null when it's unknown or expired.
export async function poForUploadLink(db: Db, token: string, now = new Date()) {
	const [link] = await db
		.select({ purchaseOrderId: poFileUploads.purchaseOrderId })
		.from(poFileUploads)
		.where(
			and(
				eq(poFileUploads.tokenHash, hash(token)),
				gt(poFileUploads.expiresAt, now),
			),
		);
	return link?.purchaseOrderId ?? null;
}

// The files in an upload: each file of a multipart form (curl -F
// file=@quote.pdf), or the whole body named by ?name= (curl --data-binary).
async function filesFromRequest(request: Request) {
	const type = request.headers.get("content-type") ?? "";
	if (type.startsWith("multipart/form-data")) {
		const form = await request.formData();
		return Promise.all(
			[...form.values()]
				.filter((v): v is File => typeof v !== "string")
				.map(async (f) => ({
					filename: f.name,
					contentType: f.type,
					data: new Uint8Array(await f.arrayBuffer()),
				})),
		);
	}
	const filename = new URL(request.url).searchParams.get("name") ?? "";
	const data = new Uint8Array(await request.arrayBuffer());
	return data.length > 0 ? [{ filename, contentType: type, data }] : [];
}

// Saves an upload's files to a PO, one at a time, and answers with their
// ids, or with why the first bad one was refused (those before it stay).
export async function fileUploadResponse(
	db: Db,
	purchaseOrderId: number,
	request: Request,
	addedBy: PoFileSource,
) {
	const files = await filesFromRequest(request).catch(() => null);
	if (!files)
		return Response.json(
			{ error: "Couldn't read the upload" },
			{ status: 400 },
		);
	if (files.length === 0)
		return Response.json({ error: "No file in the upload" }, { status: 400 });
	const fileIds: number[] = [];
	for (const f of files) {
		try {
			fileIds.push(
				(await addPoFile(db, { purchaseOrderId, addedBy, ...f })).id,
			);
		} catch (err) {
			if (!(err instanceof PurchaseOrderError)) throw err;
			return Response.json({ error: err.message, fileIds }, { status: 422 });
		}
	}
	return Response.json({ fileIds });
}
