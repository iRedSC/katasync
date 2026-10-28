import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "#/db/client";
import { locations, products } from "#/db/schema";
import { undoUnownedBatch } from "#/inventory/batch-owner";
import { requestProductCounts } from "#/inventory/count-requests";
import {
	cancelCountRequests,
	recordCount,
	requestCounts,
} from "#/inventory/ledger";
import { ourLocation, productBySku, productsBySku } from "./lookups";
import { json, WRITE } from "./tool-shapes";

export function registerStockTools(server: McpServer, db: Db) {
	// Stock

	server.registerTool(
		"record_count",
		{
			description:
				"Records how many of a product are on the shelf. The difference from what katasync thinks is booked as an adjustment (returns its batch_id for undo_stock_change). Tool sets can't be counted; count their parts.",
			inputSchema: {
				sku: z.string(),
				counted: z.number().int(),
				reason: z.enum(["count", "damaged", "found", "other"]).default("count"),
				note: z.string().optional(),
				location: z
					.string()
					.optional()
					.describe("Needed only when there are several of our locations"),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku, counted, reason, note, location }) => {
			const product = await productBySku(db, sku);
			const labels = {
				count: "Counted",
				damaged: "Damaged",
				found: "Found",
				other: "Other",
			};
			const result = await recordCount(db, {
				productId: product.id,
				locationId: await ourLocation(db, location),
				counted,
				note: [labels[reason], note?.trim(), "via Claude"]
					.filter(Boolean)
					.join(": "),
			});
			return json({ sku, ...result });
		},
	);

	server.registerTool(
		"request_counts",
		{
			description:
				"Puts shelves on the staff's cycle count list. Each stays there until someone counts it. Without a location, every shelf of ours holding the product is asked for (the warehouse when none does yet); a tool set means its parts. Shelves already on the list stay as they are. Returns the requests this added, for cancel_count_requests.",
			inputSchema: {
				skus: z.array(z.string()).min(1),
				location: z
					.string()
					.optional()
					.describe("Only this one of our locations, by name"),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ skus, location }) => {
			const found = await productsBySku(db, skus);
			const added = [];
			if (location) {
				added.push(
					...(await requestCounts(db, {
						productIds: found.map((p) => p.id),
						locationId: await ourLocation(db, location),
					})),
				);
			} else {
				added.push(
					...(await requestProductCounts(
						db,
						found.map((p) => p.id),
					)),
				);
			}
			return json({ added: await namedRequests(db, added) });
		},
	);

	server.registerTool(
		"cancel_count_requests",
		{
			description:
				"Takes count requests off the list, as request_counts returned them. One counted and asked for again since stays.",
			inputSchema: {
				requests: z
					.array(
						z.object({
							sku: z.string(),
							location: z.string(),
							requested_at: z.string(),
						}),
					)
					.min(1),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ requests }) => {
			const resolved = [];
			for (const r of requests)
				resolved.push({
					productId: (await productBySku(db, r.sku)).id,
					locationId: await ourLocation(db, r.location),
					requestedAt: r.requested_at,
				});
			return json({ cancelled: await cancelCountRequests(db, resolved) });
		},
	);

	server.registerTool(
		"undo_stock_change",
		{
			description:
				"Reverses a stock change (a ledger batch, e.g. from record_count) by posting its opposite. Changes owned by a PO, transfer, order, return, or repair must be undone there.",
			inputSchema: { batch_id: z.string().uuid() },
			annotations: WRITE,
		},
		async ({ batch_id }) => {
			return json(await undoUnownedBatch(db, batch_id));
		},
	);
}

// Count requests by SKU and location name, as cancel_count_requests takes them.
async function namedRequests(
	db: Db,
	requests: { productId: number; locationId: number; requestedAt: string }[],
) {
	if (requests.length === 0) return [];
	const [skus, places] = await Promise.all([
		db
			.select({ id: products.id, sku: products.sku })
			.from(products)
			.where(
				inArray(
					products.id,
					requests.map((r) => r.productId),
				),
			),
		db.select({ id: locations.id, name: locations.name }).from(locations),
	]);
	const sku = new Map(skus.map((p) => [p.id, p.sku]));
	const place = new Map(places.map((l) => [l.id, l.name]));
	return requests.map((r) => ({
		sku: sku.get(r.productId),
		location: place.get(r.locationId),
		requested_at: r.requestedAt,
	}));
}
