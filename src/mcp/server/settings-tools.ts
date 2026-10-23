import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import { deleteView, saveView } from "#/products/saved-views";
import { FIELDS } from "#/products/search";
import { PRODUCT_SORTS, spellProductSort } from "#/products/views";
import {
	allTemplates,
	PLACEHOLDERS,
	resetTemplate,
	saveTemplate,
	TEMPLATE_KINDS,
} from "#/purchasing/email-templates";
import { json, READ, WRITE } from "./tool-shapes";

// The wording of the emails staff send from the app, and the product list's
// saved views, as Settings and the product list change them. Nothing here
// sends an email.

const kind = z.enum(TEMPLATE_KINDS);

export function registerSettingsReadTools(server: McpServer, db: Db) {
	server.registerTool(
		"email_templates",
		{
			description:
				"The subject and body of each email staff send from the app (purchase_order, damage_report), whether it's been changed from the default, and the {placeholders} each can use.",
			annotations: READ,
		},
		async () =>
			json(
				(await allTemplates(db)).map((t) => ({
					...t,
					placeholders: PLACEHOLDERS[t.kind],
				})),
			),
	);
}

export function registerSettingsWriteTools(server: McpServer, db: Db) {
	server.registerTool(
		"save_email_template",
		{
			description:
				"Rewords an email staff send from the app. Placeholders in {braces} are filled in when it's sent (see email_templates); an unknown one is refused, and damage_report's body needs {damage_list} exactly once. Sends nothing. reset_email_template goes back to the default.",
			inputSchema: {
				kind,
				subject: z.string().min(1),
				body: z.string().min(1),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ kind, subject, body }) =>
			json({ kind, ...(await saveTemplate(db, kind, { subject, body })) }),
	);

	server.registerTool(
		"reset_email_template",
		{
			description:
				"Puts an email staff send from the app back to its default wording. Returns that wording.",
			inputSchema: { kind },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ kind }) => json({ kind, ...(await resetTemplate(db, kind)) }),
	);

	const sortKeys = Object.keys(PRODUCT_SORTS) as [
		keyof typeof PRODUCT_SORTS,
		...(keyof typeof PRODUCT_SORTS)[],
	];

	server.registerTool(
		"save_product_view",
		{
			description:
				"Saves a view on the app's product list: search chips and a sort, shown as a tab. Gives id to change one (see the product_views table), else adds one at the end. Names are unique. Within a field, chips match any of their values unless and is set; exclude chips leave matches out.",
			inputSchema: {
				id: z.number().int().positive().optional(),
				name: z.string().trim().min(1),
				filters: z.array(
					z.object({
						field: z.enum(FIELDS),
						value: z.string().min(1),
						exclude: z.boolean().default(false),
						and: z
							.boolean()
							.default(false)
							.describe(
								"Joined to the field's previous chip with AND instead of OR",
							),
						exact: z
							.boolean()
							.default(true)
							.describe("Matches the whole value, not part of it"),
					}),
				),
				sort: z
					.array(
						z.object({
							column: z.enum(sortKeys),
							desc: z.boolean().default(false),
						}),
					)
					.default([])
					.describe("First column first; empty sorts by name"),
			},
			annotations: WRITE,
		},
		async ({ id, name, filters, sort }) =>
			json(
				await saveView(db, {
					...(id ? { id } : {}),
					name,
					filters,
					sort: spellProductSort(
						sort.map((t) => ({ key: t.column, desc: t.desc })),
					),
				}),
			),
	);

	server.registerTool(
		"delete_product_view",
		{
			description:
				"Removes a saved view from the app's product list, by its id (product_views.id).",
			inputSchema: { id: z.number().int().positive() },
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ id }) => {
			await deleteView(db, id);
			return json({ deleted: id });
		},
	);
}
