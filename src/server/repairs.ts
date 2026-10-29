import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import {
	createCustomer,
	readCustomer,
	searchCustomers,
	updateCustomer,
} from "#/channels/shopify/customers";
import { shopifyAdminDraftUrl } from "#/channels/shopify/draft-orders";
import { getDb } from "#/db/client";
import { refreshDrafts } from "#/repairs/draft-sync";
import { repairInvoice } from "#/repairs/invoice";
import { listPeople } from "#/repairs/people";
import {
	boardRepairs,
	customerRepairs,
	getRepair,
	openCounts,
} from "#/repairs/read";
import {
	addLabor,
	createRepair,
	customerChanged,
	editLabor,
	editRepair,
	emailInvoice,
	moveRepair,
	RepairError,
	removeLabor,
	setPart,
} from "#/repairs/repairs";
import { addTool, editTool, removeTool, restoreTool } from "#/repairs/tools";

// The Repairs tab (src/routes/repairs). Rules live in src/repairs.

const status =
	"'received' | 'waiting_parts' | 'in_repair' | 'ready' | 'picked_up' | 'cancelled'";
const id = type({ id: "number.integer > 0" });
const customerRef = type({
	id: "string",
	name: "string",
	phone: "string | null",
	email: "string | null",
});
const toolFields = type({
	tool: "string <= 200",
	"productId?": "number.integer > 0 | null",
	"serial?": "string <= 100 | null",
	"problem?": "string <= 2000",
});
// One of the repair's tools, or null for the order as a whole.
const on = "number.integer > 0 | null";
const customerFields = type({
	firstName: "string",
	lastName: "string",
	phone: "string | null",
	email: "string | null",
});

// The board, after asking Shopify which drafts were paid. If Shopify
// doesn't answer, the board shows as it was, saying so.
export const getBoard = createServerFn({ method: "GET" }).handler(async () => {
	const db = getDb();
	const refreshed = await Promise.race([
		refreshDrafts(db).then(
			() => null,
			(e: unknown) => (e instanceof Error ? e.message : String(e)),
		),
		new Promise<string>((done) =>
			setTimeout(() => done("Shopify didn't answer in time"), 4000),
		),
	]);
	const [cards, people] = await Promise.all([boardRepairs(db), listPeople(db)]);
	return { cards, people, refreshError: refreshed };
});

export const getRepairDetail = createServerFn({ method: "GET" })
	.validator(id)
	.handler(async ({ data }) => {
		const db = getDb();
		const [detail, people] = await Promise.all([
			getRepair(db, data.id),
			listPeople(db),
		]);
		if (!detail) throw new RepairError(`No repair R${data.id}`);
		const draftUrl =
			detail.draft.kind === "open"
				? shopifyAdminDraftUrl(detail.draft.id)
				: null;
		return { ...detail, people, draftUrl };
	});

// The printed invoice, priced as Shopify has it now.
export const getRepairInvoice = createServerFn({ method: "GET" })
	.validator(id)
	.handler(async ({ data }) => {
		const invoice = await repairInvoice(getDb(), data.id);
		if (!invoice) throw new RepairError(`No repair R${data.id}`);
		return invoice;
	});

// A new repair, for a customer found in Shopify or added to it now.
export const startRepair = createServerFn({ method: "POST" })
	.validator(
		type({
			customer: customerRef.or({ new: customerFields }),
			tools: toolFields.array().atLeastLength(1),
			technicianId: "number | null",
		}),
	)
	.handler(async ({ data }) => {
		const [first, ...rest] = data.tools;
		if (!first || data.tools.some((t) => !t.tool.trim()))
			throw new RepairError("Say what each tool is");
		const customer =
			"new" in data.customer
				? await newCustomer(data.customer.new)
				: data.customer;
		const repairId = await createRepair(getDb(), {
			customer,
			tools: [first, ...rest],
			technicianId: data.technicianId,
		});
		return { id: repairId };
	});

async function newCustomer(fields: typeof customerFields.infer) {
	if (!fields.firstName.trim() && !fields.lastName.trim())
		throw new RepairError("Give the customer a name");
	const c = await createCustomer(fields);
	return { id: c.id, name: c.name, phone: c.phone, email: c.email };
}

export const changeRepair = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			"notes?": "string",
			"technicianId?": "number | null",
			"customer?": customerRef,
		}),
	)
	.handler(async ({ data: { id: repairId, ...edit } }) =>
		editRepair(getDb(), repairId, edit),
	);

export const addRepairTool = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", fields: toolFields }))
	.handler(async ({ data }) => ({
		toolId: await addTool(getDb(), data.id, data.fields),
	}));

export const changeRepairTool = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			toolId: "number.integer > 0",
			"tool?": "string <= 200",
			"productId?": "number.integer > 0 | null",
			"serial?": "string <= 100 | null",
			"problem?": "string <= 2000",
		}),
	)
	.handler(async ({ data: { id: repairId, toolId, ...edit } }) =>
		editTool(getDb(), repairId, toolId, edit),
	);

export const removeRepairTool = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", toolId: "number.integer > 0" }))
	.handler(async ({ data }) => removeTool(getDb(), data.id, data.toolId));

export const restoreRepairTool = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			removed: {
				tool: "string <= 200",
				productId: "number.integer > 0 | null",
				serial: "string <= 100 | null",
				problem: "string <= 2000",
				labor: type({ minutes: "number.integer > 0", note: "string" }).array(),
				parts: type({
					productId: "number.integer > 0",
					quantity: "1 <= number.integer <= 999",
				}).array(),
			},
		}),
	)
	.handler(async ({ data }) => ({
		toolId: await restoreTool(getDb(), data.id, data.removed),
	}));

export const moveRepairTo = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			to: status,
			"before?": "number.integer > 0 | null",
		}),
	)
	.handler(async ({ data }) =>
		moveRepair(getDb(), data.id, data.to, data.before),
	);

export const addRepairLabor = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			toolId: on,
			minutes: "number.integer",
			note: "string",
		}),
	)
	.handler(async ({ data: { id: repairId, ...labor } }) => ({
		laborId: await addLabor(getDb(), repairId, labor),
	}));

export const changeRepairLabor = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			laborId: "number.integer > 0",
			"minutes?": "number.integer",
			"note?": "string",
			"toolId?": on,
		}),
	)
	.handler(async ({ data: { id: repairId, laborId, ...edit } }) =>
		editLabor(getDb(), repairId, laborId, edit),
	);

export const removeRepairLabor = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", laborId: "number.integer > 0" }))
	.handler(async ({ data }) => removeLabor(getDb(), data.id, data.laborId));

export const setRepairPart = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			toolId: on,
			productId: "number.integer > 0",
			quantity: "number.integer >= 0",
		}),
	)
	.handler(async ({ data: { id: repairId, ...part } }) =>
		setPart(getDb(), repairId, part),
	);

export const emailRepairInvoice = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => ({
		sentTo: await emailInvoice(getDb(), data.id),
	}));

// Customers, from Shopify, with how many repairs each has in the shop.
export const findCustomers = createServerFn({ method: "GET" })
	.validator(type({ q: "string" }))
	.handler(async ({ data }) => {
		const found = await searchCustomers(data.q);
		const open = await openCounts(
			getDb(),
			found.map((c) => c.id),
		);
		return found.map((c) => ({ ...c, openRepairs: open.get(c.id) ?? 0 }));
	});

export const getCustomer = createServerFn({ method: "GET" })
	.validator(type({ id: "string" }))
	.handler(async ({ data }) => {
		const [customer, list] = await Promise.all([
			readCustomer(data.id),
			customerRepairs(getDb(), data.id),
		]);
		if (!customer) throw new RepairError("That customer is gone from Shopify");
		return { customer, repairs: list };
	});

// Adds or edits a customer in Shopify. An edit also updates the name and
// phone their open repairs show.
export const saveCustomer = createServerFn({ method: "POST" })
	.validator(type({ "id?": "string", fields: customerFields }))
	.handler(async ({ data }) => {
		if (!data.fields.firstName.trim() && !data.fields.lastName.trim())
			throw new RepairError("Give the customer a name");
		if (!data.id) return createCustomer(data.fields);
		const c = await updateCustomer(data.id, data.fields);
		await customerChanged(getDb(), c);
		return c;
	});
