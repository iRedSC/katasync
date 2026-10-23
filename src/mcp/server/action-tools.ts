import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { syncAllChannels } from "#/channels/sync-now";
import type { Db } from "#/db/client";
import { stores } from "#/db/schema";
import { receiveReturn, undoReturns } from "#/orders/returns";
import { markNoReturn, restoreNoReturn } from "#/orders/returns-due";
import { cancelOrder, closeOrder, restoreOrder } from "#/purchasing/orders";
import { setStorePush } from "#/stock-push/switch";
import { productBySku } from "./lookups";
import { orderForClaude } from "./po-for-claude";
import { json, WRITE } from "./tool-shapes";

// What the app does with returns, POs, stock push, and syncing, for Claude.
// Nothing here reaches a supplier or carrier, or spends money.
export function registerActionTools(server: McpServer, db: Db) {
	server.registerTool(
		"receive_return",
		{
			description:
				"Receives units a customer sent back, by order_lines.id (find them with the query tool). outcome restock puts them back on the shelf the order takes stock from (the warehouse for a shipped order, the retail store for an in-store sale); write_off records them as damaged; { refurbish_into } puts one line's units on the shelf as an existing refurbished product made from what the line sold (products.refurbished_from_id). Making a new refurb drafts it in Shopify, so that stays in the app. Only once the order has shipped, and never more than a line sold. Returns the return ids for undo_return.",
			inputSchema: {
				order_id: z.number().int().positive(),
				lines: z
					.array(
						z.object({
							line_id: z.number().int().positive(),
							quantity: z.number().int().positive(),
						}),
					)
					.min(1),
				outcome: z.union([
					z.enum(["restock", "write_off"]),
					z.object({ refurbish_into: z.string().describe("The refurb's SKU") }),
				]),
			},
			annotations: WRITE,
		},
		async ({ order_id, lines, outcome }) =>
			json(
				await receiveReturn(db, {
					orderId: order_id,
					lines: lines.map((l) => ({
						lineId: l.line_id,
						quantity: l.quantity,
					})),
					outcome:
						typeof outcome === "string"
							? outcome
							: {
									refurbishInto: (
										await productBySku(db, outcome.refurbish_into)
									).id,
								},
				}),
			),
	);

	server.registerTool(
		"undo_return",
		{
			description:
				"Takes received returns back off, by the ids receive_return gave: restocked units leave the shelf again.",
			inputSchema: { return_ids: z.array(z.number().int().positive()).min(1) },
			annotations: WRITE,
		},
		async ({ return_ids }) => {
			const { problems } = await undoReturns(db, return_ids);
			return json({ undone: return_ids, problems });
		},
	);

	server.registerTool(
		"mark_no_return",
		{
			description:
				"Says nothing is coming back on an order: its refunded items count as a cost now and it leaves the Returns tab. Undo with expect_return.",
			inputSchema: { order_id: z.number().int().positive() },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ order_id }) => {
			await markNoReturn(db, order_id);
			return json({ order_id, no_return: true });
		},
	);

	server.registerTool(
		"expect_return",
		{
			description:
				"Undoes mark_no_return: the order is back on the Returns tab, waiting for its items.",
			inputSchema: { order_id: z.number().int().positive() },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ order_id }) => {
			await restoreNoReturn(db, order_id, null);
			return json({ order_id, no_return: false });
		},
	);

	server.registerTool(
		"close_po",
		{
			description:
				"Stops waiting for what hasn't arrived on a sent PO (the supplier is out of it, or it's not worth chasing). Tells no one.",
			inputSchema: { po: z.number().int().positive() },
			annotations: WRITE,
		},
		async ({ po }) => {
			await closeOrder(db, po);
			return json(await orderForClaude(db, po));
		},
	);

	server.registerTool(
		"cancel_po",
		{
			description:
				"Calls off a sent PO nothing has arrived on; once anything has, use close_po. Tells no one: the user tells the supplier. Drafts are deleted with delete_draft_po instead. Undo with restore_po.",
			inputSchema: { po: z.number().int().positive() },
			annotations: WRITE,
		},
		async ({ po }) => {
			await cancelOrder(db, po);
			return json(await orderForClaude(db, po));
		},
	);

	server.registerTool(
		"restore_po",
		{
			description: "Undoes cancel_po: the PO is on order again.",
			inputSchema: { po: z.number().int().positive() },
			annotations: WRITE,
		},
		async ({ po }) => {
			await restoreOrder(db, po);
			return json(await orderForClaude(db, po));
		},
	);

	server.registerTool(
		"set_stock_push",
		{
			description:
				"Turns a store's stock push on or off, by store name (see the stores table). While on, katasync sets that store's quantities from ours. Turning it on is refused while something would make every quantity wrong, and starts from a fresh read of the channel.",
			inputSchema: { store: z.string(), on: z.boolean() },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ store, on }) => {
			const [found] = await db
				.select({ id: stores.id })
				.from(stores)
				.where(eq(stores.name, store));
			if (!found) throw new Error(`No store called ${store}`);
			return json({ ...(await setStorePush(db, found.id, on)), on });
		},
	);

	server.registerTool(
		"sync_now",
		{
			description:
				"Syncs every connected channel now (orders, listings, stock push), as the Sync button does, and says how each went. Can take a minute.",
			annotations: WRITE,
		},
		async () => json(await syncAllChannels(db, 0)),
	);
}
