import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { capabilityUrl } from "#/auth/capability-urls";
import type { Db } from "#/db/client";
import { MAX_PO_FILE_BYTES } from "#/purchasing/file-limits";
import {
	addPoFile,
	createFileUploadLink,
	poFile,
	setPoFileRemoved,
} from "#/purchasing/files";
import { PurchaseOrderError } from "#/purchasing/orders";
import { describeFile, fileContent } from "./email-files";
import { json, READ, WRITE } from "./tool-shapes";

// Files put on a PO itself (get_purchase_order lists them as files); its
// emails' files are read with read_po_email.

const MB = MAX_PO_FILE_BYTES / 1_000_000;

export function registerFileReadTools(server: McpServer, db: Db) {
	server.registerTool(
		"read_po_file",
		{
			description:
				"One file put on a PO (an id from get_purchase_order's files): its text when it's a PDF with text in it, and the file itself, an image or a PDF as an embedded resource. Files from the PO's emails are read with read_po_email instead.",
			inputSchema: { id: z.number().int().positive() },
			annotations: READ,
		},
		async ({ id }) => {
			const file = await poFile(db, id);
			if (!file || file.removedAt)
				throw new PurchaseOrderError(`There's no PO file ${id}`);
			return {
				content: [
					...json(
						describeFile(file, {
							id: file.id,
							po: file.purchaseOrderId,
							addedBy: file.addedBy,
							addedAt: file.createdAt,
						}),
					).content,
					...fileContent(
						`katasync://po-files/${file.id}/${encodeURIComponent(file.filename)}`,
						file,
						file.text,
					),
				],
			};
		},
	);
}

export function registerFileTools(server: McpServer, db: Db) {
	server.registerTool(
		"attach_po_file",
		{
			description: `Puts a file on a PO, base64 in the call, for files Claude made or was given without a shell: a quote, a packing slip, a BOL. Up to ${MB} MB; for anything bigger than a page or two, po_file_upload_link is cheaper. Shows on the PO's Files card for staff. A suggested PO becomes a draft.`,
			inputSchema: {
				po: z.number().int().positive(),
				filename: z
					.string()
					.min(1)
					.describe("With its extension, e.g. quote-4471.pdf"),
				content_base64: z.string().min(1),
				content_type: z
					.string()
					.optional()
					.describe(
						"e.g. application/pdf; taken from the extension if left out",
					),
			},
			annotations: WRITE,
		},
		async ({ po, filename, content_base64, content_type }) => {
			// Buffer skips what isn't base64, so a mangled file would save as
			// garbage that looks fine; it has to read back the same.
			const given = content_base64.replace(/\s/g, "");
			const data = Buffer.from(given, "base64");
			const strip = (b64: string) => b64.replace(/=+$/, "");
			if (
				data.length === 0 ||
				strip(data.toString("base64")) !==
					strip(given.replace(/-/g, "+").replace(/_/g, "/"))
			)
				throw new PurchaseOrderError("content_base64 isn't valid base64");
			const file = await addPoFile(db, {
				purchaseOrderId: po,
				filename,
				contentType: content_type ?? "",
				data,
				addedBy: "claude",
			});
			return json({ po, ...file });
		},
	);

	server.registerTool(
		"po_file_upload_link",
		{
			description: `A link to put files on a PO with curl from a shell, for 30 minutes and any number of files. Each shows on the PO's Files card for staff. A suggested PO becomes a draft with the first file.`,
			inputSchema: { po: z.number().int().positive() },
			annotations: WRITE,
		},
		async ({ po }) => {
			const { token, expiresAt } = await createFileUploadLink(db, po);
			const url = capabilityUrl("/api/uploads/po-file/", token);
			return json({
				url,
				expiresAt,
				how: `curl -F file=@quote.pdf ${url}  (one file per request, up to ${MB} MB; answers with fileIds for read_po_file)`,
			});
		},
	);

	server.registerTool(
		"remove_po_file",
		{
			description:
				"Takes a file off a PO (one put on it, not an email's), e.g. one attached to the wrong PO. Nothing is deleted: restore true puts it back.",
			inputSchema: {
				id: z.number().int().positive(),
				restore: z.boolean().optional(),
			},
			annotations: WRITE,
		},
		async ({ id, restore }) => json(await setPoFileRemoved(db, id, !restore)),
	);
}
