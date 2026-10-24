import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { relyingParty } from "#/auth/webauthn";
import type { Db } from "#/db/client";
import { type BuyerMedia, buyerReplyFiles } from "#/db/schema";
import type { Market } from "#/markets/market";
import { ATTACHMENT_RULES, MAX_FILE_BYTES, refuseFiles } from "./attachments";

// Files attached to replies, kept before the reply is sent. Server only.

const ANY_TYPE = new Set(
	Object.values(ATTACHMENT_RULES).flatMap((r) => Object.keys(r.types)),
);

export class ReplyFileError extends Error {
	name = "ReplyFileError";
}

export async function addReplyFile(
	db: Db,
	f: { filename: string; contentType: string; data: Uint8Array },
) {
	const contentType = f.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (!ANY_TYPE.has(contentType))
		throw new ReplyFileError("No marketplace takes that kind of file");
	if (f.data.length === 0) throw new ReplyFileError("That file is empty");
	if (f.data.length > MAX_FILE_BYTES)
		throw new ReplyFileError(`Files can be up to ${MAX_FILE_BYTES / 1e6} MB`);
	const [row] = await db
		.insert(buyerReplyFiles)
		.values({
			filename: f.filename || "file",
			contentType,
			size: f.data.length,
			data: Buffer.from(f.data),
			shareToken: randomBytes(24).toString("base64url"),
		})
		.returning({ id: buyerReplyFiles.id });
	if (!row) throw new Error("The file wasn't kept");
	return { id: row.id };
}

export const replyFileUrl = (id: number) => `/api/buyer-files/${id}`;

export async function replyFile(db: Db, id: number) {
	const [row] = await db
		.select()
		.from(buyerReplyFiles)
		.where(eq(buyerReplyFiles.id, id));
	return row ?? null;
}

// The file at its public address, for a marketplace fetching it.
export async function sharedFile(db: Db, token: string) {
	const [row] = await db
		.select()
		.from(buyerReplyFiles)
		.where(eq(buyerReplyFiles.shareToken, token));
	return row ?? null;
}

export const sharedFileUrl = (token: string) =>
	`${relyingParty().origin}/api/shared-files/${token}`;

// A reply's files, checked against the marketplace's rules, as the media
// the reply is kept with. Throws when one is missing or the marketplace
// won't take them.
export async function filesForReply(db: Db, market: Market, ids: number[]) {
	if (ids.length === 0) return [];
	const rows = await db
		.select({
			id: buyerReplyFiles.id,
			filename: buyerReplyFiles.filename,
			contentType: buyerReplyFiles.contentType,
			size: buyerReplyFiles.size,
		})
		.from(buyerReplyFiles)
		.where(inArray(buyerReplyFiles.id, ids));
	const byId = new Map(rows.map((r) => [r.id, r]));
	const files = ids.map((id) => byId.get(id));
	if (files.some((f) => !f)) throw new ReplyFileError("A file went missing");
	const kept = files.filter((f) => f !== undefined);
	const why = refuseFiles(
		market,
		kept.map((f) => ({ name: f.filename, type: f.contentType, size: f.size })),
	);
	if (why) throw new ReplyFileError(why);
	const rules = market === "shopify" ? null : ATTACHMENT_RULES[market];
	return kept.map(
		(f): BuyerMedia => ({
			kind: rules?.types[f.contentType] ?? "FILE",
			name: f.filename,
			url: replyFileUrl(f.id),
			fileId: f.id,
		}),
	);
}

// The files whose bytes a send needs, in the reply's order.
export async function replyFileData(db: Db, media: BuyerMedia[]) {
	const ids = media.flatMap((m) => (m.fileId ? [m.fileId] : []));
	if (ids.length === 0) return [];
	const rows = await db
		.select()
		.from(buyerReplyFiles)
		.where(inArray(buyerReplyFiles.id, ids));
	const byId = new Map(rows.map((r) => [r.id, r]));
	return ids.map((id) => {
		const row = byId.get(id);
		if (!row) throw new ReplyFileError("A file went missing");
		return row;
	});
}

// The body of an upload: the whole request, named by ?name=.
export async function uploadResponse(db: Db, request: Request) {
	const filename = new URL(request.url).searchParams.get("name") ?? "";
	const contentType = request.headers.get("content-type") ?? "";
	let data: Uint8Array;
	try {
		data = new Uint8Array(await request.arrayBuffer());
	} catch {
		return Response.json(
			{ error: "Couldn't read the upload" },
			{ status: 400 },
		);
	}
	try {
		return Response.json(
			await addReplyFile(db, { filename, contentType, data }),
		);
	} catch (error) {
		if (!(error instanceof ReplyFileError)) throw error;
		return Response.json({ error: error.message }, { status: 422 });
	}
}
