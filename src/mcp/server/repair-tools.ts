import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
	createCustomer,
	readCustomer,
	searchCustomers,
	updateCustomer,
} from "#/channels/shopify/customers";
import type { Db } from "#/db/client";
import { people } from "#/db/repair-schema";
import { formatMinutes } from "#/repairs/labor";
import { getRepair, openCounts } from "#/repairs/read";
import {
	addLabor,
	createRepair,
	customerChanged,
	editLabor,
	editRepair,
	moveRepair,
	RepairError,
	removeLabor,
	setPart,
} from "#/repairs/repairs";
import { addTool, editTool, removeTool } from "#/repairs/tools";
import { productBySku } from "./lookups";
import { json, READ, WRITE } from "./tool-shapes";

// Repairs over MCP. Charges are written to the repair's Shopify draft
// order as they change; nothing here takes payment or emails the customer,
// and tickets and invoices print from the app.

const status = z.enum([
	"received",
	"waiting_parts",
	"in_repair",
	"ready",
	"picked_up",
	"cancelled",
]);
const customerFields = {
	first_name: z.string(),
	last_name: z.string(),
	phone: z.string().nullable().optional(),
	email: z.string().nullable().optional(),
};
const fieldsOf = (c: {
	first_name: string;
	last_name: string;
	phone?: string | null;
	email?: string | null;
}) => ({
	firstName: c.first_name,
	lastName: c.last_name,
	phone: c.phone ?? null,
	email: c.email ?? null,
});

async function repairForClaude(db: Db, id: number) {
	const d = await getRepair(db, id);
	if (!d) throw new RepairError(`No repair R${id}`);
	const { repair: r } = d;
	return {
		repair: `R${r.id}`,
		status: r.status,
		customer: {
			id: r.customerId,
			name: r.customerName,
			phone: r.customerPhone,
			email: r.customerEmail,
		},
		tools: d.tools.map((t) => ({
			id: t.id,
			tool: t.tool,
			serial: t.serial,
			problem: t.problem,
		})),
		notes: r.notes,
		technician: r.technician,
		labor: d.labor.map((l) => ({
			id: l.id,
			tool_id: l.toolId,
			time: formatMinutes(l.minutes),
			minutes: l.minutes,
			note: l.note,
		})),
		parts: d.parts.map((p) => ({
			tool_id: p.toolId,
			sku: p.sku,
			name: p.name,
			quantity: p.quantity,
			onShopify: p.onShopify,
		})),
		draft: d.draft,
		order: r.orderName,
	};
}

async function personId(db: Db, name: string | null) {
	if (name === null) return null;
	const [p] = await db
		.select({ id: people.id })
		.from(people)
		.where(
			and(
				sql`lower(${people.name}) = lower(${name.trim()})`,
				isNull(people.archivedAt),
			),
		);
	if (!p) throw new RepairError(`No one called ${name} in Settings, People`);
	return p.id;
}

const number = z
	.number()
	.int()
	.positive()
	.describe("The repair's number, 1001 for R1001");
const toolId = z
	.number()
	.int()
	.positive()
	.nullable()
	.describe(
		"Which of the repair's tools (its id from get_repair), or null for the order as a whole",
	);
const toolFields = {
	tool: z.string().min(1),
	serial: z.string().optional(),
	problem: z.string().optional(),
};

export function registerRepairReadTools(server: McpServer, db: Db) {
	server.registerTool(
		"get_repair",
		{
			description:
				"A repair: status, customer, its tools (each with an id, serial, and problem), technician, labor entries and parts (each with the tool_id it's on, null for the order as a whole), and its Shopify draft order as Shopify has it now (lines added in Shopify listed as others, totals). For lists, query the repairs, repair_tools, repair_labor, repair_parts, and people tables.",
			inputSchema: { number },
			annotations: READ,
		},
		async ({ number: id }) => json(await repairForClaude(db, id)),
	);

	server.registerTool(
		"search_customers",
		{
			description:
				"Finds Shopify customers by name, email, or phone (digits in any format). Empty lists the most recently updated. Each has its Shopify id, used by create_repair, and how many repairs it has in the shop.",
			inputSchema: { query: z.string() },
			annotations: { ...READ, openWorldHint: true },
		},
		async ({ query }) => {
			const found = await searchCustomers(query);
			const open = await openCounts(
				db,
				found.map((c) => c.id),
			);
			return json(
				found.map((c) => ({ ...c, openRepairs: open.get(c.id) ?? 0 })),
			);
		},
	);
}

export function registerRepairTools(server: McpServer, db: Db) {
	server.registerTool(
		"create_repair",
		{
			description:
				"Takes in a customer's tools for repair, one or more on one repair, in Received. Give customer_id from search_customers, or new_customer to add one to Shopify. Their tickets print from the app (the repair's page, Tickets), one per tool.",
			inputSchema: {
				customer_id: z.string().optional(),
				new_customer: z.object(customerFields).optional(),
				tools: z.array(z.object(toolFields)).min(1),
				technician: z
					.string()
					.optional()
					.describe("A name from Settings, People"),
			},
			annotations: { ...WRITE, openWorldHint: true },
		},
		async (a) => {
			const c = a.customer_id
				? await readCustomer(a.customer_id)
				: a.new_customer
					? await createCustomer(fieldsOf(a.new_customer))
					: null;
			if (!c || (a.customer_id && a.new_customer))
				throw new RepairError(
					"Give a customer_id from search_customers, or new_customer, not both",
				);
			const id = await createRepair(db, {
				customer: { id: c.id, name: c.name, phone: c.phone, email: c.email },
				tools: [a.tools[0], ...a.tools.slice(1)],
				technicianId: await personId(db, a.technician ?? null),
			});
			return json(await repairForClaude(db, id));
		},
	);

	server.registerTool(
		"update_repair",
		{
			description:
				"Changes a repair's notes, technician, or customer, or moves it (set_repair_tool changes its tools). status moves between received, waiting_parts, in_repair, and ready freely; picked_up only when it has nothing to charge (a draft order is paid in Shopify, which moves it itself); cancelled takes its charges off the draft order, and moving a cancelled one back puts them on again. technician null takes it off whoever had it.",
			inputSchema: {
				number,
				status: status.optional(),
				notes: z.string().optional().describe("Shop notes, not on the order"),
				technician: z.string().nullable().optional(),
				customer_id: z.string().optional(),
			},
			annotations: { ...WRITE, openWorldHint: true },
		},
		async (a) => {
			const customer = a.customer_id ? await readCustomer(a.customer_id) : null;
			if (a.customer_id && !customer)
				throw new RepairError("No such customer in Shopify");
			const edit = {
				...(a.notes !== undefined && { notes: a.notes }),
				...(a.technician !== undefined && {
					technicianId: await personId(db, a.technician),
				}),
				...(customer && {
					customer: {
						id: customer.id,
						name: customer.name,
						phone: customer.phone,
						email: customer.email,
					},
				}),
			};
			if (Object.keys(edit).length > 0) await editRepair(db, a.number, edit);
			if (a.status) await moveRepair(db, a.number, a.status);
			return json(await repairForClaude(db, a.number));
		},
	);

	server.registerTool(
		"set_repair_labor",
		{
			description:
				"Adds, changes, or removes time on one of a repair's tools or on the order as a whole, in 15-minute steps. Each tool's time is billed on the draft order as Shopify's labor variants (Labor @ $/hr, 15m to 2h), at Shopify's price. Omit labor_id to add (tool_id required); give remove to take one off; tool_id with labor_id moves it.",
			inputSchema: {
				number,
				tool_id: toolId.optional(),
				labor_id: z.number().int().positive().optional(),
				minutes: z.number().int().positive().optional(),
				note: z.string().optional(),
				remove: z.boolean().optional(),
			},
			annotations: { ...WRITE, openWorldHint: true },
		},
		async (a) => {
			if (a.labor_id === undefined) {
				if (!a.minutes) throw new RepairError("Say how many minutes");
				if (a.tool_id === undefined)
					throw new RepairError(
						"Say which tool the time is on, or null for the order",
					);
				await addLabor(db, a.number, {
					toolId: a.tool_id,
					minutes: a.minutes,
					note: a.note ?? "",
				});
			} else if (a.remove) await removeLabor(db, a.number, a.labor_id);
			else
				await editLabor(db, a.number, a.labor_id, {
					minutes: a.minutes,
					note: a.note,
					toolId: a.tool_id,
				});
			return json(await repairForClaude(db, a.number));
		},
	);

	server.registerTool(
		"set_repair_parts",
		{
			description:
				"Sets how many of each part went into one of a repair's tools, or onto the order as a whole, charged at its Shopify price; 0 takes one off. A part can be on several tools. Only products sold on Shopify can be charged. Their stock comes off when the paid order syncs in, like any sale.",
			inputSchema: {
				number,
				tool_id: toolId,
				parts: z
					.array(
						z.object({ sku: z.string(), quantity: z.number().int().min(0) }),
					)
					.min(1),
			},
			annotations: { ...WRITE, openWorldHint: true, idempotentHint: true },
		},
		async (a) => {
			for (const p of a.parts)
				await setPart(db, a.number, {
					toolId: a.tool_id,
					productId: (await productBySku(db, p.sku)).id,
					quantity: p.quantity,
				});
			return json(await repairForClaude(db, a.number));
		},
	);

	server.registerTool(
		"set_repair_tool",
		{
			description:
				"Adds a tool to a customer's repair (omit tool_id), changes one (tool_id with the fields to change), or takes one off with its labor and parts (tool_id with remove). A repair keeps at least one tool; a bench job's is its one unit.",
			inputSchema: {
				number,
				tool_id: z.number().int().positive().optional(),
				tool: z.string().optional(),
				serial: z.string().nullable().optional(),
				problem: z.string().optional(),
				remove: z.boolean().optional(),
			},
			annotations: { ...WRITE, openWorldHint: true },
		},
		async (a) => {
			if (a.tool_id === undefined) {
				if (!a.tool) throw new RepairError("Say what the tool is");
				await addTool(db, a.number, {
					tool: a.tool,
					serial: a.serial,
					problem: a.problem,
				});
			} else if (a.remove) await removeTool(db, a.number, a.tool_id);
			else
				await editTool(db, a.number, a.tool_id, {
					...(a.tool !== undefined && { tool: a.tool, productId: null }),
					...(a.serial !== undefined && { serial: a.serial }),
					...(a.problem !== undefined && { problem: a.problem }),
				});
			return json(await repairForClaude(db, a.number));
		},
	);

	server.registerTool(
		"save_customer",
		{
			description:
				"Adds a customer to Shopify, or changes one (with id). Phones without a country code are US.",
			inputSchema: { id: z.string().optional(), ...customerFields },
			annotations: { ...WRITE, openWorldHint: true },
		},
		async (a) => {
			if (!a.id) return json(await createCustomer(fieldsOf(a)));
			const c = await updateCustomer(a.id, fieldsOf(a));
			await customerChanged(db, c);
			return json(c);
		},
	);
}

// Kept beside the tools, so the pair can't drift.
export const REPAIR_READ_TOOLS = ["get_repair", "search_customers"];
