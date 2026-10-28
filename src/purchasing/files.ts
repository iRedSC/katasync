import { createHash, randomBytes } from "node:crypto";
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	ne,
	notExists,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "#/db/client";
import {
	poEmailAttachments,
	poEmails,
	poFileUploads,
	purchaseOrderFiles,
} from "#/db/schema";
import { fileType } from "#/lib/file-type";
import { isPdf, pdfText } from "#/purchasing/inbox/pdf-text";
import {
	lockForEdit,
	lockOrder,
	PurchaseOrderError,
	poName,
} from "#/purchasing/orders";
import { MAX_PO_FILE_BYTES } from "./file-limits";

// Files put on a PO itself, by staff from its page or by Claude. Any PO but
// a suggested one takes them; adding one to a suggested PO saves it as a
// draft, as any first change does. Removing a file only marks it, so Undo
// can put it back.

const UPLOAD_LINK_MINUTES = 30;
const ANY = ["draft", "sent", "closed", "cancelled"] as const;

export type PoFileSource = "staff" | "claude";

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
	const contentType = fileType(input.contentType, filename);
	// Read before the lock, so a slow PDF doesn't hold the PO.
	const text = isPdf(contentType, filename) ? await pdfText(data) : null;
	const sha256 = createHash("sha256").update(data).digest("hex");
	return db.transaction(async (tx) => {
		await lockForEdit(tx, input.purchaseOrderId, [...ANY]);
		const same = await sameFileOn(tx, input.purchaseOrderId, sha256);
		if (same)
			throw new PurchaseOrderError(
				same === filename
					? `${filename} is already on this PO`
					: `${filename} is already on this PO, as ${same}`,
			);
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

// The name the PO has this file under already, among its own files and its
// emails', or null.
async function sameFileOn(db: Db, purchaseOrderId: number, sha256: string) {
	const [own] = await db
		.select({ filename: purchaseOrderFiles.filename })
		.from(purchaseOrderFiles)
		.where(
			and(
				eq(purchaseOrderFiles.purchaseOrderId, purchaseOrderId),
				eq(purchaseOrderFiles.sha256, sha256),
				isNull(purchaseOrderFiles.removedAt),
			),
		)
		.limit(1);
	if (own) return own.filename;
	const [emailed] = await db
		.select({ filename: poEmailAttachments.filename })
		.from(poEmailAttachments)
		.innerJoin(poEmails, eq(poEmails.id, poEmailAttachments.emailId))
		.where(
			and(
				eq(poEmails.purchaseOrderId, purchaseOrderId),
				eq(poEmailAttachments.sha256, sha256),
				isNull(poEmailAttachments.removedAt),
				isNull(poEmailAttachments.contentId),
			),
		)
		.limit(1);
	return emailed?.filename ?? null;
}

const live = alias(purchaseOrderFiles, "live");

// Takes files off a PO, its own and its emails' (the emails keep theirs), or
// with removed false puts them back. An own file the PO has again since stays
// off: the PO has it. Answers how many changed.
export async function setPoFilesRemoved(
	db: Db,
	ids: { files: number[]; attachments: number[] },
	removed: boolean,
) {
	const at = removed ? new Date() : null;
	return db.transaction(async (tx) => {
		const files =
			ids.files.length === 0
				? []
				: await tx
						.update(purchaseOrderFiles)
						.set({ removedAt: at })
						.where(
							and(
								inArray(purchaseOrderFiles.id, ids.files),
								removed
									? isNull(purchaseOrderFiles.removedAt)
									: and(
											isNotNull(purchaseOrderFiles.removedAt),
											notExists(
												tx
													.select({ id: live.id })
													.from(live)
													.where(
														and(
															eq(
																live.purchaseOrderId,
																purchaseOrderFiles.purchaseOrderId,
															),
															eq(live.sha256, purchaseOrderFiles.sha256),
															ne(live.id, purchaseOrderFiles.id),
															isNull(live.removedAt),
														),
													),
											),
										),
							),
						)
						.returning({ id: purchaseOrderFiles.id });
		const attachments =
			ids.attachments.length === 0
				? []
				: await tx
						.update(poEmailAttachments)
						.set({ removedAt: at })
						.where(
							and(
								inArray(poEmailAttachments.id, ids.attachments),
								isNull(poEmailAttachments.contentId),
								removed
									? isNull(poEmailAttachments.removedAt)
									: isNotNull(poEmailAttachments.removedAt),
							),
						)
						.returning({ id: poEmailAttachments.id });
		return { files: files.length, attachments: attachments.length };
	});
}

// Takes one of a PO's own files off it, or with removed false puts it back.
export async function setPoFileRemoved(db: Db, id: number, removed = true) {
	const [row] = await db
		.select({
			id: purchaseOrderFiles.id,
			purchaseOrderId: purchaseOrderFiles.purchaseOrderId,
			filename: purchaseOrderFiles.filename,
		})
		.from(purchaseOrderFiles)
		.where(eq(purchaseOrderFiles.id, id));
	const changed = await setPoFilesRemoved(
		db,
		{ files: [id], attachments: [] },
		removed,
	);
	if (!row || changed.files === 0)
		throw new PurchaseOrderError(
			removed ? "That file is already off the PO" : "That file is on its PO",
		);
	return row;
}

// Moves a file from one PO to another, as one row of the Files card: its own
// copies and its emails' come off the PO it's on, and the other PO gets it as
// its own (left as it is if it has it already). The emails keep theirs, so
// an email about several POs can share its files out. Answers the file
// added, or null, for Undo.
export async function movePoFiles(
	db: Db,
	input: {
		from: number;
		to: number;
		files: number[];
		attachments: number[];
		movedBy: PoFileSource;
	},
) {
	if (input.from === input.to)
		throw new PurchaseOrderError(`That file is on ${poName(input.to)} already`);
	return db.transaction(async (tx) => {
		const own =
			input.files.length === 0
				? []
				: await tx
						.select()
						.from(purchaseOrderFiles)
						.where(
							and(
								inArray(purchaseOrderFiles.id, input.files),
								eq(purchaseOrderFiles.purchaseOrderId, input.from),
								isNull(purchaseOrderFiles.removedAt),
							),
						);
		const emailed =
			input.attachments.length === 0
				? []
				: await tx
						.select({ file: poEmailAttachments })
						.from(poEmailAttachments)
						.innerJoin(poEmails, eq(poEmails.id, poEmailAttachments.emailId))
						.where(
							and(
								inArray(poEmailAttachments.id, input.attachments),
								eq(poEmails.purchaseOrderId, input.from),
								isNull(poEmailAttachments.removedAt),
								isNull(poEmailAttachments.contentId),
							),
						)
						.then((rows) => rows.map((r) => r.file));
		if (
			own.length !== new Set(input.files).size ||
			emailed.length !== new Set(input.attachments).size
		)
			throw new PurchaseOrderError(
				`That file isn't on ${poName(input.from)} any more`,
			);
		const source = [...own, ...emailed].find((f) => f.data !== null);
		if (!source?.data)
			throw new PurchaseOrderError(
				"That file was too large to keep, so only Outlook has it",
			);
		if (source.size > MAX_PO_FILE_BYTES)
			throw new PurchaseOrderError(
				`${source.filename} is ${(source.size / 1e6).toFixed(1)} MB; a PO's files can be up to ${MAX_PO_FILE_BYTES / 1e6} MB`,
			);
		await lockForEdit(tx, input.to, [...ANY]);
		const sha256 = createHash("sha256").update(source.data).digest("hex");
		const added = (await sameFileOn(tx, input.to, sha256))
			? null
			: (
					await tx
						.insert(purchaseOrderFiles)
						.values({
							purchaseOrderId: input.to,
							filename: source.filename,
							contentType: source.contentType,
							size: source.size,
							data: source.data,
							text: source.text,
							addedBy: input.movedBy,
							// Who sent it: the email's file, or the one this PO's
							// own copy was moved from.
							fromAttachmentId:
								emailed[0]?.id ??
								own.find((f) => f.fromAttachmentId !== null)
									?.fromAttachmentId ??
								null,
						})
						.returning({ id: purchaseOrderFiles.id })
				)[0].id;
		await setPoFilesRemoved(
			tx,
			{ files: input.files, attachments: input.attachments },
			true,
		);
		return { filename: source.filename, to: input.to, added };
	});
}

// Undoes movePoFiles: the file it added comes off, and the ones it took off
// go back.
export async function unmovePoFiles(
	db: Db,
	moved: { added: number | null; files: number[]; attachments: number[] },
) {
	return db.transaction(async (tx) => {
		if (moved.added !== null)
			await setPoFilesRemoved(
				tx,
				{ files: [moved.added], attachments: [] },
				true,
			);
		return setPoFilesRemoved(
			tx,
			{ files: moved.files, attachments: moved.attachments },
			false,
		);
	});
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
			sha256: purchaseOrderFiles.sha256,
			// The email it was moved from, when it was.
			sentBy: sql<
				string | null
			>`coalesce(${poEmails.fromName}, ${poEmails.fromAddress})`,
			sentAt: poEmails.receivedAt,
		})
		.from(purchaseOrderFiles)
		.leftJoin(
			poEmailAttachments,
			eq(poEmailAttachments.id, purchaseOrderFiles.fromAttachmentId),
		)
		.leftJoin(poEmails, eq(poEmails.id, poEmailAttachments.emailId))
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
