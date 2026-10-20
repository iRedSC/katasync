import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Db, getDb } from "#/db/client";
import {
	locations,
	products,
	shelfTargets,
	stockLevels,
	transferLines,
	transfers,
} from "#/db/schema";
import { isOurs } from "#/inventory/locations";
import {
	fillFromSuggestions,
	refillSuggestions,
	setShelfTarget,
} from "#/inventory/refill";
import {
	createTransfer,
	deleteTransfer,
	moveNow,
	sendTransfer,
	setTransferLines,
	unsendTransfer,
	updateTransfer,
} from "#/inventory/transfers";

const fromPlace = alias(locations, "from_place");
const toPlace = alias(locations, "to_place");

// The warehouse and the retail store, the pair a refill goes between.
async function refillPair(db: Db) {
	const rows = await db
		.select({ id: locations.id, kind: locations.kind })
		.from(locations)
		.where(isOurs);
	const warehouse = rows.filter((r) => r.kind === "owned");
	const retail = rows.filter((r) => r.kind === "retail");
	return warehouse.length === 1 && retail.length === 1
		? { fromLocationId: warehouse[0].id, toLocationId: retail[0].id }
		: null;
}

// Drafts first, then the last 100 sent, with what each moves.
export const listTransfers = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const totals = db
			.select({
				transferId: transferLines.transferId,
				lines: sql<number>`count(*)::int`.as("lines"),
				units: sql<number>`sum(${transferLines.quantity})::int`.as("units"),
			})
			.from(transferLines)
			.groupBy(transferLines.transferId)
			.as("totals");
		const select = () =>
			db
				.select({
					id: transfers.id,
					status: transfers.status,
					from: fromPlace.name,
					to: toPlace.name,
					note: transfers.note,
					createdAt: transfers.createdAt,
					sentAt: transfers.sentAt,
					lines: sql<number>`coalesce(${totals.lines}, 0)`,
					units: sql<number>`coalesce(${totals.units}, 0)`,
				})
				.from(transfers)
				.innerJoin(fromPlace, eq(fromPlace.id, transfers.fromLocationId))
				.innerJoin(toPlace, eq(toPlace.id, transfers.toLocationId))
				.leftJoin(totals, eq(totals.transferId, transfers.id));
		const pair = await refillPair(db);
		const [drafts, sent, places, refill] = await Promise.all([
			select()
				.where(eq(transfers.status, "draft"))
				.orderBy(desc(transfers.createdAt)),
			select()
				.where(eq(transfers.status, "sent"))
				.orderBy(desc(transfers.sentAt))
				.limit(100),
			db
				.select({
					id: locations.id,
					name: locations.name,
					kind: locations.kind,
				})
				.from(locations)
				.where(isOurs)
				.orderBy(locations.kind, locations.name),
			pair ? refillSuggestions(db, pair) : Promise.resolve([]),
		]);
		return {
			drafts,
			sent,
			places,
			refill: {
				possible: pair !== null,
				ready: refill.filter((r) => r.suggested > 0).length,
				none: refill.filter((r) => r.suggested === 0).length,
			},
		};
	},
);

// One transfer: its lines with what each end holds, and, on a draft, what a
// refill would add.
export const getTransfer = createServerFn({ method: "GET" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [t] = await db
			.select({
				id: transfers.id,
				status: transfers.status,
				fromLocationId: transfers.fromLocationId,
				toLocationId: transfers.toLocationId,
				from: fromPlace.name,
				to: toPlace.name,
				note: transfers.note,
				createdAt: transfers.createdAt,
				sentAt: transfers.sentAt,
			})
			.from(transfers)
			.innerJoin(fromPlace, eq(fromPlace.id, transfers.fromLocationId))
			.innerJoin(toPlace, eq(toPlace.id, transfers.toLocationId))
			.where(eq(transfers.id, data.id));
		if (!t) throw new Error(`No transfer T${data.id}`);
		const lines = await db
			.select({
				productId: products.id,
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				quantity: transferLines.quantity,
			})
			.from(transferLines)
			.innerJoin(products, eq(products.id, transferLines.productId))
			.where(eq(transferLines.transferId, t.id))
			.orderBy(products.sku);
		const ids = lines.map((l) => l.productId);
		const [levels, targets, suggestions] = await Promise.all([
			ids.length === 0
				? []
				: db
						.select()
						.from(stockLevels)
						.where(
							and(
								inArray(stockLevels.productId, ids),
								inArray(stockLevels.locationId, [
									t.fromLocationId,
									t.toLocationId,
								]),
							),
						),
			ids.length === 0
				? []
				: db
						.select()
						.from(shelfTargets)
						.where(
							and(
								inArray(shelfTargets.productId, ids),
								eq(shelfTargets.locationId, t.toLocationId),
							),
						),
			t.status === "draft" ? refillSuggestions(db, t) : [],
		]);
		const at = (productId: number, locationId: number) =>
			levels.find(
				(l) => l.productId === productId && l.locationId === locationId,
			)?.onHand ?? 0;
		return {
			transfer: t,
			lines: lines.map((l) => ({
				...l,
				atSource: at(l.productId, t.fromLocationId),
				atDestination: at(l.productId, t.toLocationId),
				target:
					targets.find((x) => x.productId === l.productId)?.target ?? null,
			})),
			// Below target and not already on this draft.
			suggestions: suggestions.filter(
				(s) => !ids.includes(s.productId) && s.suggested > 0,
			),
		};
	});

export const newTransfer = createServerFn({ method: "POST" })
	.validator(
		type({
			fromLocationId: "number.integer > 0",
			toLocationId: "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => ({ id: await createTransfer(getDb(), data) }));

// A draft from the warehouse to the retail store, filled with what tops
// the store up to its targets.
export const newRefill = createServerFn({ method: "POST" }).handler(
	async () => {
		const db = getDb();
		const pair = await refillPair(db);
		if (!pair)
			throw new Error("A refill needs one warehouse and one retail store");
		const id = await createTransfer(db, pair);
		const filled = await fillFromSuggestions(db, id);
		return { id, ...filled };
	},
);

export const fillTransfer = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => fillFromSuggestions(getDb(), data.id));

export const setTransferLine = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			productId: "number.integer > 0",
			quantity: "number.integer >= 0",
		}),
	)
	.handler(async ({ data }) =>
		setTransferLines(getDb(), data.id, [
			{ productId: data.productId, quantity: data.quantity },
		]),
	);

export const editTransfer = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			"note?": "string | null",
			"swap?": "boolean",
		}),
	)
	.handler(async ({ data }) => updateTransfer(getDb(), data.id, data));

export const removeTransfer = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => deleteTransfer(getDb(), data.id));

export const sendTransferNow = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => sendTransfer(getDb(), data.id));

export const undoTransferSend = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", "discard?": "boolean" }))
	.handler(async ({ data }) =>
		unsendTransfer(getDb(), data.id, { discard: data.discard }),
	);

// One product moved now from the product page.
export const recordTransfer = createServerFn({ method: "POST" })
	.validator(
		type({
			sku: "string > 0",
			fromLocationId: "number.integer > 0",
			toLocationId: "number.integer > 0",
			quantity: "number.integer > 0",
			"note?": "string",
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const [product] = await db
			.select({ id: products.id })
			.from(products)
			.where(eq(products.sku, data.sku));
		if (!product) throw new Error(`No product ${data.sku}`);
		return moveNow(db, { ...data, productId: product.id });
	});

export const saveShelfTarget = createServerFn({ method: "POST" })
	.validator(
		type({
			productId: "number.integer > 0",
			locationId: "number.integer > 0",
			target: "number.integer >= 0 | null",
		}),
	)
	.handler(async ({ data }) => setShelfTarget(getDb(), data));
