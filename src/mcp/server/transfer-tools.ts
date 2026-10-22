import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "#/db/client";
import { locations, products, transferLines, transfers } from "#/db/schema";
import {
	fillFromSuggestions,
	refillSuggestions,
	setShelfTarget,
} from "#/inventory/refill";
import {
	createDraftWith,
	deleteTransfer,
	moveNow,
	sendTransfer,
	setTransferLines,
	TransferError,
	transferName,
	unsendTransfer,
	updateTransfer,
} from "#/inventory/transfers";
import { PurchaseOrderError } from "#/purchasing/orders";
import { ourLocation, productBySku } from "./lookups";
import { json, READ, WRITE } from "./tool-shapes";

const transferId = z
	.number()
	.int()
	.positive()
	.describe("The transfer's number, 12 for T12");

// The retail store, where refills and targets go unless told otherwise.
async function retailStore(db: Db) {
	const found = await db
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "retail"));
	if (found.length !== 1)
		throw new TransferError("Name the location; there isn't one retail store");
	return found[0].id;
}

async function warehouse(db: Db) {
	const found = await db
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "owned"));
	if (found.length !== 1)
		throw new TransferError("Name the location; there isn't one warehouse");
	return found[0].id;
}

// The product each line names, in one lookup. Names are trimmed as productBySku
// trims them.
async function linesBySku(db: Db, lines: { sku: string; quantity: number }[]) {
	if (lines.length === 0) return [];
	const found = await db
		.select({ id: products.id, sku: products.sku })
		.from(products)
		.where(
			inArray(
				products.sku,
				lines.map((l) => l.sku.trim()),
			),
		);
	const idBySku = new Map(found.map((p) => [p.sku, p.id]));
	return lines.map((l) => {
		const productId = idBySku.get(l.sku.trim());
		if (productId === undefined)
			throw new PurchaseOrderError(`No product with SKU ${l.sku}`);
		return { productId, quantity: l.quantity };
	});
}

async function describeTransfer(db: Db, id: number) {
	const [t] = await db.select().from(transfers).where(eq(transfers.id, id));
	if (!t) throw new TransferError(`No transfer ${transferName(id)}`);
	const lines = await db
		.select({ sku: products.sku, quantity: transferLines.quantity })
		.from(transferLines)
		.innerJoin(products, eq(products.id, transferLines.productId))
		.where(eq(transferLines.transferId, id))
		.orderBy(products.sku);
	return { transfer: transferName(id), ...t, lines };
}

export function registerTransferReadTools(server: McpServer, db: Db) {
	server.registerTool(
		"refill_suggestions",
		{
			description:
				"Products below their target at a location (by default the retail store), with what topping each up would take from the source (by default the warehouse) as far as the source has it. suggested 0 means the source has none.",
			inputSchema: {
				from: z.string().optional(),
				to: z.string().optional(),
			},
			annotations: READ,
		},
		async ({ from, to }) =>
			json(
				await refillSuggestions(db, {
					fromLocationId: from
						? await ourLocation(db, from)
						: await warehouse(db),
					toLocationId: to ? await ourLocation(db, to) : await retailStore(db),
				}),
			),
	);

	server.registerTool(
		"get_transfer",
		{
			description:
				"A transfer: its route, status (draft or sent), note, and lines. List them with the query tool (transfers, transfer_lines).",
			inputSchema: { transfer: transferId },
			annotations: READ,
		},
		async ({ transfer }) => json(await describeTransfer(db, transfer)),
	);
}

export function registerTransferTools(server: McpServer, db: Db) {
	server.registerTool(
		"transfer_stock",
		{
			description:
				"Moves units of one product between our own locations right now, as a sent one-line transfer. Refused when the location it leaves doesn't hold that many; ask for a count there instead. Undo with undo_transfer.",
			inputSchema: {
				sku: z.string(),
				quantity: z.number().int().positive(),
				from: z.string().describe("Location name the units leave"),
				to: z.string().describe("Location name the units go to"),
				note: z.string().optional(),
			},
			annotations: WRITE,
		},
		async ({ sku, quantity, from, to, note }) => {
			const product = await productBySku(db, sku);
			const { transferId: id } = await moveNow(db, {
				productId: product.id,
				fromLocationId: await ourLocation(db, from),
				toLocationId: await ourLocation(db, to),
				quantity,
				note: [note?.trim(), "via Claude"].filter(Boolean).join(": "),
			});
			return json({ transfer: transferName(id), sku, quantity, from, to });
		},
	);

	server.registerTool(
		"create_transfer",
		{
			description:
				"Starts a draft transfer between two of our locations (by default warehouse to retail store). Give lines, or refill: true to fill it with what tops the destination up to its targets. Nothing moves until send_transfer.",
			inputSchema: {
				from: z.string().optional(),
				to: z.string().optional(),
				note: z.string().optional(),
				lines: z
					.array(
						z.object({
							sku: z.string(),
							quantity: z.number().int().positive(),
						}),
					)
					.optional(),
				refill: z.boolean().optional(),
			},
			annotations: WRITE,
		},
		async ({ from, to, note, lines, refill }) => {
			// Resolved before anything is written, so a bad SKU leaves no draft.
			const { id, filled } = await createDraftWith(
				db,
				{
					fromLocationId: from
						? await ourLocation(db, from)
						: await warehouse(db),
					toLocationId: to ? await ourLocation(db, to) : await retailStore(db),
					note,
					lines: lines ? await linesBySku(db, lines) : undefined,
				},
				async (tx, draft) => (refill ? fillFromSuggestions(tx, draft) : null),
			);
			return json({
				...(await describeTransfer(db, id)),
				...(filled ? { source_has_none_of: filled.none } : {}),
			});
		},
	);

	server.registerTool(
		"set_transfer_lines",
		{
			description:
				"Sets how many of each product a draft transfer moves. Quantity 0 takes a product off; products not named stay. Tool sets move as their parts.",
			inputSchema: {
				transfer: transferId,
				lines: z
					.array(
						z.object({ sku: z.string(), quantity: z.number().int().min(0) }),
					)
					.min(1),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ transfer, lines }) => {
			await setTransferLines(db, transfer, await linesBySku(db, lines));
			return json(await describeTransfer(db, transfer));
		},
	);

	server.registerTool(
		"edit_transfer",
		{
			description:
				"Changes a draft transfer's note, or swaps its direction (swap: true).",
			inputSchema: {
				transfer: transferId,
				note: z.string().nullable().optional(),
				swap: z.boolean().optional(),
			},
			annotations: WRITE,
		},
		async ({ transfer, note, swap }) => {
			await updateTransfer(db, transfer, { note, swap });
			return json(await describeTransfer(db, transfer));
		},
	);

	server.registerTool(
		"send_transfer",
		{
			description:
				"Sends a draft transfer: every line moves at once. Refused, moving nothing, if the source is short of any line. Undo with undo_transfer.",
			inputSchema: { transfer: transferId },
			annotations: WRITE,
		},
		async ({ transfer }) => {
			await sendTransfer(db, transfer);
			return json(await describeTransfer(db, transfer));
		},
	);

	server.registerTool(
		"undo_transfer",
		{
			description:
				"Moves a sent transfer's stock back. It becomes a draft again, to fix and send again or delete.",
			inputSchema: { transfer: transferId },
			annotations: WRITE,
		},
		async ({ transfer }) => {
			await unsendTransfer(db, transfer);
			return json(await describeTransfer(db, transfer));
		},
	);

	server.registerTool(
		"delete_transfer",
		{
			description: "Deletes a draft transfer. A sent one must be undone first.",
			inputSchema: { transfer: transferId },
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ transfer }) => {
			await deleteTransfer(db, transfer);
			return json({ deleted: transferName(transfer) });
		},
	);

	server.registerTool(
		"set_shelf_target",
		{
			description:
				"How many of a product a location should hold (by default the retail store). Refills top it back up to this from the warehouse. target null stops refilling it there. Tool sets take targets on their parts.",
			inputSchema: {
				sku: z.string(),
				target: z.number().int().min(0).nullable(),
				location: z.string().optional(),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku, target, location }) => {
			const product = await productBySku(db, sku);
			await setShelfTarget(db, {
				productId: product.id,
				locationId: location
					? await ourLocation(db, location)
					: await retailStore(db),
				target,
			});
			return json({ sku, target });
		},
	);
}
