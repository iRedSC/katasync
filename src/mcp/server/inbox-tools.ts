import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "#/db/client";
import { poEmails } from "#/db/schema";
import {
	mailboxMessage,
	messageContent,
	searchMailbox,
} from "#/purchasing/inbox/graph";
import {
	emailsOf,
	emailWithFiles,
	fileEmail,
	importEmail,
	setAside,
	unfiledEmails,
} from "#/purchasing/inbox/ingest";
import { PurchaseOrderError } from "#/purchasing/orders";
import { addTracking, removeTracking } from "#/purchasing/tracking";
import { describeFile, fileContent, liveFiles } from "./email-files";
import { json, READ, WRITE } from "./tool-shapes";

// The purchasing inbox: emails katasync filed on POs or is waiting to file,
// and the whole mailbox behind it, read live from Microsoft 365.

export function registerInboxReadTools(server: McpServer, db: Db) {
	server.registerTool(
		"po_emails",
		{
			description:
				"Emails from the purchasing inbox that katasync keeps: those filed on a PO (also listed in get_purchase_order) or, with unfiled, those waiting to be filed. An email is filed by itself only when sent to the PO's own address (purchasing+po1234@) or its subject names the PO and it's from that supplier's domain; the rest wait here for file_po_email or set_aside_po_email. Bodies are cut to 600 characters; read_po_email gives the whole email and its files.",
			inputSchema: {
				po: z.number().int().positive().optional(),
				unfiled: z.boolean().optional().describe("Emails not on any PO"),
				include_set_aside: z
					.boolean()
					.optional()
					.describe("With unfiled: also those set aside as about no PO"),
				limit: z.number().int().min(1).max(200).optional(),
			},
			annotations: READ,
		},
		async ({ po, unfiled, include_set_aside, limit }) => {
			if (!po && !unfiled)
				throw new PurchaseOrderError("Give a po, or unfiled: true");
			const rows = po
				? await emailsOf(db, po)
				: await unfiledEmails(db, { setAside: include_set_aside, limit });
			return json(
				rows.slice(0, limit ?? 200).map((e) => ({
					id: e.id,
					po: e.purchaseOrderId,
					matchedBy: e.matchedBy,
					setAside: e.setAsideAt !== null,
					from: e.fromName ? `${e.fromName} <${e.fromAddress}>` : e.fromAddress,
					subject: e.subject,
					receivedAt: e.receivedAt,
					body: e.body.length > 600 ? `${e.body.slice(0, 600)}…` : e.body,
					attachments: e.attachments.map((a) =>
						describeFile(a, { id: a.id, hasText: a.hasText }),
					),
				})),
			);
		},
	);

	server.registerTool(
		"read_po_email",
		{
			description:
				"One kept email in full: sender, recipients, body, and each attachment's text (PDFs' text is read when the email arrives). With attachment, that file itself too: an image, or a PDF as an embedded resource (useful for scans, which have no text). Use it to check an invoice or confirmation against the PO with match_invoice.",
			inputSchema: {
				id: z.number().int().positive(),
				attachment: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("An attachment id from this email, to get the file"),
			},
			annotations: READ,
		},
		async ({ id, attachment }) => {
			const { email, files } = await emailWithFiles(db, id);
			const summary = {
				id: email.id,
				po: email.purchaseOrderId,
				matchedBy: email.matchedBy,
				setAside: email.setAsideAt !== null,
				from: email.fromName
					? `${email.fromName} <${email.fromAddress}>`
					: email.fromAddress,
				to: email.recipients,
				subject: email.subject,
				receivedAt: email.receivedAt,
				body: email.body,
				attachments: files.map((f) =>
					describeFile(f, {
						id: f.id,
						kept: f.data !== null,
						...(f.text ? { text: f.text } : {}),
					}),
				),
			};
			if (attachment === undefined) return json(summary);
			const file = files.find((f) => f.id === attachment);
			if (!file)
				throw new PurchaseOrderError(
					`Email ${id} has no attachment ${attachment}`,
				);
			return {
				content: [
					...json({ ...summary, attachments: undefined }).content,
					...fileContent(
						`katasync://po-email-attachments/${file.id}/${encodeURIComponent(file.filename)}`,
						file,
						file.text,
					),
				],
			};
		},
	);

	server.registerTool(
		"search_inbox",
		{
			description:
				'Searches the whole purchasing mailbox in Microsoft 365, every folder and as far back as it goes, including emails from before katasync read the inbox and ones it never kept. words uses Outlook search (sender, subject, body, attachment names), e.g. "TSW invoice" or an invoice number; without words, lists newest first. since/until (ISO dates) narrow by when it arrived. Each result has graph_id for read_inbox_email, ours (sent by us), and kept: katasync\'s email id and PO when it has the email.',
			inputSchema: {
				words: z.string().min(1).optional(),
				since: z.string().optional().describe("ISO date or time"),
				until: z.string().optional().describe("ISO date or time"),
				limit: z.number().int().min(1).max(100).optional(),
			},
			annotations: { ...READ, openWorldHint: true },
		},
		async ({ words, since, until, limit }) => {
			const date = (s: string | undefined, name: string) => {
				if (!s) return undefined;
				const d = new Date(s);
				if (Number.isNaN(d.getTime()))
					throw new PurchaseOrderError(`${name} isn't a date: ${s}`);
				return d;
			};
			const found = await searchMailbox({
				words,
				since: date(since, "since"),
				until: date(until, "until"),
				limit: limit ?? 25,
			});
			const kept =
				found.length === 0
					? []
					: await db
							.select({
								id: poEmails.id,
								messageId: poEmails.messageId,
								po: poEmails.purchaseOrderId,
								setAsideAt: poEmails.setAsideAt,
							})
							.from(poEmails)
							.where(
								inArray(
									poEmails.messageId,
									found.map((m) => m.messageId),
								),
							);
			const byMessage = new Map(kept.map((k) => [k.messageId, k]));
			return json(
				found.map((m) => {
					const k = byMessage.get(m.messageId);
					return {
						graph_id: m.graphId,
						from: m.fromName
							? `${m.fromName} <${m.fromAddress}>`
							: m.fromAddress,
						to: m.recipients,
						subject: m.subject,
						receivedAt: m.receivedAt,
						ours: m.ours,
						kept: k
							? { id: k.id, po: k.po, setAside: k.setAsideAt !== null }
							: null,
					};
				}),
			);
		},
	);

	server.registerTool(
		"read_inbox_email",
		{
			description:
				"Reads any email in the purchasing mailbox by its graph_id from search_inbox, live: body and each attachment's text. With attachment (its index in attachments, from 0), that file itself too. Reading keeps nothing; to put the email on a PO, use file_po_email with graph_id.",
			inputSchema: {
				graph_id: z.string().min(1),
				attachment: z.number().int().min(0).optional(),
			},
			annotations: { ...READ, openWorldHint: true },
		},
		async ({ graph_id, attachment }) => {
			const [m, content] = await Promise.all([
				mailboxMessage(graph_id),
				messageContent(graph_id),
			]);
			const files = await liveFiles(content.attachments);
			const summary = {
				graph_id: m.graphId,
				from: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
				to: m.recipients,
				subject: m.subject,
				receivedAt: m.receivedAt,
				ours: m.ours,
				body: content.body,
				attachments: files.map((f, index) =>
					describeFile(f, {
						index,
						kept: f.data !== null,
						...(f.text ? { text: f.text } : {}),
					}),
				),
			};
			if (attachment === undefined) return json(summary);
			const file = files[attachment];
			if (!file)
				throw new PurchaseOrderError(
					`That email has ${files.length} attachments; there's no ${attachment}`,
				);
			return {
				content: [
					...json({ ...summary, attachments: undefined }).content,
					...fileContent(
						`katasync://inbox/${encodeURIComponent(graph_id)}/${attachment}`,
						file,
						file.text,
					),
				],
			};
		},
	);
}

export function registerInboxWriteTools(server: McpServer, db: Db) {
	server.registerTool(
		"file_po_email",
		{
			description:
				"Puts an email on a PO (a sent one), or moves it to another; po null takes it off, back to unfiled. Give id for an email katasync keeps (po_emails), or graph_id for any email in the mailbox (search_inbox), which keeps it first. Tracking numbers in it are then followed on that PO, and no longer on the one it left. Changes nothing on the PO itself and tells nobody.",
			inputSchema: {
				id: z.number().int().positive().optional(),
				graph_id: z.string().min(1).optional(),
				po: z.number().int().positive().nullable(),
			},
			annotations: WRITE,
		},
		async ({ id, graph_id, po }) => {
			if ((id === undefined) === (graph_id === undefined))
				throw new PurchaseOrderError("Give id or graph_id, not both");
			if (id !== undefined)
				return json(
					await fileEmail(db, {
						emailId: id,
						purchaseOrderId: po,
						by: "claude",
					}),
				);
			const message = await mailboxMessage(graph_id ?? "");
			if (message.ours)
				throw new PurchaseOrderError(
					"That email was sent by us; only emails from suppliers are kept",
				);
			return json(await importEmail(db, message, po));
		},
	);

	server.registerTool(
		"set_aside_po_email",
		{
			description:
				"Marks an unfiled email as about no PO (a newsletter, a quote), so it leaves the list waiting to be filed. undo puts it back.",
			inputSchema: {
				id: z.number().int().positive(),
				undo: z.boolean().optional(),
			},
			annotations: WRITE,
		},
		async ({ id, undo }) => json(await setAside(db, id, !undo)),
	);

	server.registerTool(
		"add_po_tracking",
		{
			description:
				"Follows a package for a sent PO on Shippo, e.g. a number from a packing slip PDF or one written oddly. The carrier is worked out from UPS and USPS numbers; give it for FedEx. Returns Shippo's first answer. Only shown on the PO: a delivery never receives or closes it.",
			inputSchema: {
				po: z.number().int().positive(),
				number: z.string().min(8),
				carrier: z.enum(["ups", "usps", "fedex"]).optional(),
			},
			annotations: { ...WRITE, openWorldHint: true },
		},
		async ({ po, number, carrier }) =>
			json(await addTracking(db, { purchaseOrderId: po, number, carrier })),
	);

	server.registerTool(
		"remove_po_tracking",
		{
			description:
				"Stops following a tracking number on a PO, e.g. one read from an email that wasn't tracking. Its id is in get_purchase_order's tracking.",
			inputSchema: { id: z.number().int().positive() },
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ id }) => json(await removeTracking(db, id)),
	);
}
