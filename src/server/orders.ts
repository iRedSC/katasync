import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import { lineAwaitsMatch } from "#/channels/unmatched";
import { getDb } from "#/db/client";
import {
	dispatches,
	dispatchOrders,
	locations,
	orderCharges,
	orderCostChecks,
	orderCostReports,
	orderLines,
	orderProfit,
	orderReturns,
	orderReturnsDue,
	orders,
	productComponents,
	products,
	type ReturnState,
	returnRequests,
	shipments,
	stores,
} from "#/db/schema";
import { cityLine } from "#/lib/format";
import { groupBy } from "#/lib/group-by";
import { adminUrls } from "#/orders/admin-urls";
import { fromStore } from "#/orders/from-store";
import { sharingOrders } from "#/orders/invoice-index";
import { refurbishOptions, refurbishReturn } from "#/orders/refurbish";
import { receiveReturn, undoReturns } from "#/orders/returns";
import {
	findReturnable,
	listReturns,
	markNoReturn,
	restoreNoReturn,
} from "#/orders/returns-due";
import { labelToVoid, needsShipping } from "#/orders/to-ship";
import { boxSize } from "#/shipping/box-filter";
import { contentsKey } from "#/shipping/contents";
import { liveDispatches } from "#/shipping/dispatch";
import { lastPackedFor } from "#/shipping/quick-ship";

export const countOrdersToShip = createServerFn({ method: "GET" }).handler(
	async () => {
		const [{ count }] = await getDb()
			.select({ count: sql<number>`count(*)::int` })
			.from(orders)
			.where(needsShipping);
		return count;
	},
);

export const listOrders = createServerFn({ method: "GET" })
	.validator(type({ view: "'ship' | 'all'" }))
	.handler(async ({ data }) => {
		const scope =
			data.view === "ship" ? or(needsShipping, labelToVoid) : undefined;
		const lineStats = getDb()
			.select({
				orderId: orderLines.orderId,
				items: sql<number>`sum(${orderLines.quantity})::int`.as("items"),
				// Lines from a listing still waiting for its product. Custom items
				// have no listing and are never matched.
				unmatched:
					sql<number>`count(*) filter (where ${lineAwaitsMatch({ productId: orderLines.productId, storeId: orders.storeId, listingExternalId: orderLines.listingExternalId })})::int`.as(
						"unmatched",
					),
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.groupBy(orderLines.orderId)
			.as("line_stats");
		const listed = await getDb()
			.select({
				id: orders.id,
				name: orders.name,
				pin: orders.pin,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
				externalId: orders.externalId,
				placedAt: orders.placedAt,
				cancelledAt: orders.cancelledAt,
				fulfillmentStatus: orders.fulfillmentStatus,
				financialStatus: orders.financialStatus,
				customerName: orders.customerName,
				shipCity: orders.shipCity,
				shipCountry: orders.shipCountry,
				shipRegion: orders.shipRegion,
				total: orders.total,
				store: stores.name,
				channel: stores.channel,
				items: sql<number>`coalesce(${lineStats.items}, 0)`,
				unmatched: sql<number>`coalesce(${lineStats.unmatched}, 0)`,
				labelToVoid,
				invoicePrintedAt: orders.invoicePrintedAt,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.leftJoin(lineStats, eq(lineStats.orderId, orders.id))
			// A cancelled order with a live label stays in view until it's voided.
			.where(scope)
			.orderBy(desc(orders.placedAt))
			.limit(data.view === "ship" ? 500 : 200);
		// Each order's lines, for its products column and the search. The title
		// is the marketplace's, as on the order page; the photo is katasync's.
		const lines = await getDb()
			.select({
				orderId: orderLines.orderId,
				id: orderLines.id,
				title: orderLines.title,
				sku: orderLines.sku,
				quantity: orderLines.quantity,
				productSku: products.sku,
				productName: products.name,
				imageUrl: products.imageUrl,
				fromStore,
			})
			.from(orderLines)
			.leftJoin(products, eq(products.id, orderLines.productId))
			.where(
				inArray(
					orderLines.orderId,
					listed.map((o) => o.id),
				),
			)
			.orderBy(orderLines.id);
		const linesOf = new Map<
			number,
			Omit<(typeof lines)[number], "orderId">[]
		>();
		for (const { orderId, ...line } of lines) {
			linesOf.set(orderId, [...(linesOf.get(orderId) ?? []), line]);
		}
		// How many the view holds, so the list can say when it's cut short.
		const [{ total }] = await getDb()
			.select({ total: sql<number>`count(*)::int` })
			.from(orders)
			.where(scope);
		return {
			orders: listed.map((o) => ({ ...o, lines: linesOf.get(o.id) ?? [] })),
			total,
		};
	});

export const getOrder = createServerFn({ method: "GET" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [order] = await db
			.select({
				id: orders.id,
				name: orders.name,
				pin: orders.pin,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
				placedAt: orders.placedAt,
				cancelledAt: orders.cancelledAt,
				fulfillmentStatus: orders.fulfillmentStatus,
				fulfilledByChannel: orders.fulfilledByChannel,
				financialStatus: orders.financialStatus,
				customerName: orders.customerName,
				shipAddress1: orders.shipAddress1,
				shipAddress2: orders.shipAddress2,
				shipCity: orders.shipCity,
				shipRegion: orders.shipRegion,
				shipPostalCode: orders.shipPostalCode,
				shipCountry: orders.shipCountry,
				shipPhone: orders.shipPhone,
				total: orders.total,
				shippingCharged: orders.shippingCharged,
				externalId: orders.externalId,
				store: stores.name,
				channel: stores.channel,
				labelToVoid,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(eq(orders.id, data.id));
		if (!order) throw new Error(`No order ${data.id}`);
		const lines = await db
			.select({
				id: orderLines.id,
				title: orderLines.title,
				sku: orderLines.sku,
				quantity: orderLines.quantity,
				unitPrice: orderLines.unitPrice,
				unitCost: orderLines.unitCost,
				tookStock: sql<boolean>`${orderLines.saleBatchId} is not null`,
				fromStore,
				// Units received back, and how many of those went on the shelf.
				returned: sql<number>`coalesce((select sum(${orderReturns.quantity}) from ${orderReturns} where ${orderReturns.orderLineId} = ${orderLines.id}), 0)::int`,
				// Back on a shelf, as itself or as a refurb, or before cutover.
				restocked: sql<number>`coalesce((select sum(${orderReturns.quantity}) from ${orderReturns} where ${orderReturns.orderLineId} = ${orderLines.id} and (${orderReturns.restocked} or ${orderReturns.refurbProductId} is not null or ${orderReturns.preCutover})), 0)::int`,
				productSku: products.sku,
				productName: products.name,
				imageUrl: products.imageUrl,
				// Its listing has no product yet. Custom items have no listing.
				awaitsMatch: lineAwaitsMatch({
					productId: orderLines.productId,
					storeId: orders.storeId,
					listingExternalId: orderLines.listingExternalId,
				}),
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.leftJoin(products, eq(products.id, orderLines.productId))
			.where(eq(orderLines.orderId, data.id))
			.orderBy(orderLines.id);
		// Every dispatch this order went out in (or will): its boxes, this
		// order's tracking handoff, and any other orders in the same box.
		const handoffs = await db
			.select({
				dispatchId: dispatchOrders.dispatchId,
				channelSentAt: dispatchOrders.channelSentAt,
				channelError: dispatchOrders.channelError,
				channelRetryAt: dispatchOrders.channelRetryAt,
				reversedAt: dispatchOrders.reversedAt,
				boughtAt: dispatches.boughtAt,
			})
			.from(dispatchOrders)
			.innerJoin(dispatches, eq(dispatches.id, dispatchOrders.dispatchId))
			.where(eq(dispatchOrders.orderId, data.id))
			.orderBy(dispatchOrders.dispatchId);
		const ids = handoffs.map((h) => h.dispatchId);
		const boxes = ids.length
			? await db
					.select({
						id: shipments.id,
						dispatchId: shipments.dispatchId,
						serviceName: shipments.serviceName,
						cost: shipments.cost,
						trackingNumber: shipments.trackingNumber,
						trackingUrl: shipments.trackingUrl,
						provider: shipments.provider,
						test: shipments.test,
						voidedAt: shipments.voidedAt,
						refundStatus: shipments.refundStatus,
						storefrontTrackingError: shipments.storefrontTrackingError,
						createdAt: shipments.createdAt,
					})
					.from(shipments)
					.where(inArray(shipments.dispatchId, ids))
					.orderBy(shipments.id)
			: [];
		const others = ids.length
			? await db
					.select({
						dispatchId: dispatchOrders.dispatchId,
						id: orders.id,
						name: orders.name,
					})
					.from(dispatchOrders)
					.innerJoin(orders, eq(orders.id, dispatchOrders.orderId))
					.where(
						and(
							inArray(dispatchOrders.dispatchId, ids),
							ne(dispatchOrders.orderId, data.id),
						),
					)
					.orderBy(orders.id)
			: [];
		// A purchase whose first box failed leaves a dispatch with no boxes;
		// there's nothing to show for it.
		const sends = handoffs.flatMap((h) => {
			const own = boxes.filter((b) => b.dispatchId === h.dispatchId);
			if (own.length === 0) return [];
			return {
				id: h.dispatchId,
				channelSentAt: h.channelSentAt,
				channelError: h.channelError,
				// Still being sent again on its own (src/shipping/retry.ts).
				retrying: h.channelRetryAt !== null,
				// False when a box failed part way: void only, never send.
				complete: h.boughtAt !== null,
				// Voided, but taking it back for this order didn't finish.
				unfinishedVoid: h.reversedAt === null,
				boxes: own,
				live: own.some((b) => b.voidedAt === null),
				shippedWith: others.filter((o) => o.dispatchId === h.dispatchId),
			};
		});
		// What it made, and what each marketplace said it charged.
		const [[profit], charges, reports, checks, [due], requests] =
			await Promise.all([
				db.select().from(orderProfit).where(eq(orderProfit.orderId, data.id)),
				db
					.select({
						billedBy: orderCharges.billedBy,
						kind: orderCharges.kind,
						description: orderCharges.description,
						amount: orderCharges.amount,
					})
					.from(orderCharges)
					.where(eq(orderCharges.orderId, data.id))
					.orderBy(orderCharges.id),
				db
					.select({
						billedBy: orderCostReports.billedBy,
						settled: orderCostReports.settled,
						fetchedAt: orderCostReports.fetchedAt,
					})
					.from(orderCostReports)
					.where(eq(orderCostReports.orderId, data.id)),
				db
					.select({
						billedBy: orderCostChecks.billedBy,
						checkedAt: orderCostChecks.checkedAt,
						error: orderCostChecks.error,
					})
					.from(orderCostChecks)
					.where(eq(orderCostChecks.orderId, data.id)),
				// What's due back, as the Returns tab has it.
				db
					.select({ state: orderReturnsDue.state })
					.from(orderReturnsDue)
					.where(eq(orderReturnsDue.orderId, data.id))
					.limit(1),
				db
					.select({
						billedBy: returnRequests.billedBy,
						status: returnRequests.status,
						rawStatus: returnRequests.rawStatus,
						reason: returnRequests.reason,
						trackingNumber: returnRequests.trackingNumber,
						carrier: returnRequests.carrier,
						requestedAt: returnRequests.requestedAt,
					})
					.from(returnRequests)
					.where(eq(returnRequests.orderId, data.id))
					.orderBy(desc(returnRequests.requestedAt)),
			]);
		return {
			order,
			lines,
			sends,
			// Amazon orders already link there to fulfill.
			adminUrls: adminUrls(order).filter((p) => p.channel !== "amazon"),
			profit: profit ?? null,
			charges,
			reports,
			checks,
			returnState: (due?.state ?? null) as ReturnState | null,
			returnRequests: requests,
		};
	});

export const receiveOrderReturn = createServerFn({ method: "POST" })
	.validator(
		type({
			orderId: "number.integer > 0",
			lines: type({
				lineId: "number.integer > 0",
				quantity: "number.integer >= 0",
			}).array(),
			outcome: type("'restock' | 'write_off'").or({
				refurbishInto: "number.integer > 0",
			}),
		}),
	)
	.handler(({ data }) => receiveReturn(getDb(), data));

export const undoOrderReturn = createServerFn({ method: "POST" })
	.validator(type({ ids: "(number.integer > 0)[]" }))
	.handler(({ data }) => undoReturns(getDb(), data.ids));

// The refurb dialog: what a returned line's refurb starts as.
export const getRefurbishOptions = createServerFn({ method: "POST" })
	.validator(
		type({ orderId: "number.integer > 0", lineId: "number.integer > 0" }),
	)
	.handler(({ data }) => refurbishOptions(getDb(), data));

export const refurbishOrderReturn = createServerFn({ method: "POST" })
	.validator(
		type({
			orderId: "number.integer > 0",
			lineId: "number.integer > 0",
			quantity: "number.integer > 0",
			condition: "string > 0",
			title: "string > 0",
			price: "number > 0",
			compareAtPrice: "number > 0 | null",
			weightGrams: "number.integer > 0 | null",
			vendor: "string",
			productType: "string",
			tags: "string[]",
			notes: "string",
		}),
	)
	.handler(({ data }) => refurbishReturn(getDb(), data));

// The Returns tab: what's due back, and what came back lately.
export const getReturns = createServerFn({ method: "GET" }).handler(() =>
	listReturns(getDb()),
);

export const searchReturnable = createServerFn({ method: "GET" })
	.validator(type({ q: "string <= 200" }))
	.handler(({ data }) => findReturnable(getDb(), data.q));

export const markOrderNoReturn = createServerFn({ method: "POST" })
	.validator(type({ orderId: "number.integer > 0" }))
	.handler(({ data }) => markNoReturn(getDb(), data.orderId));

export const undoOrderNoReturn = createServerFn({ method: "POST" })
	.validator(type({ orderId: "number.integer > 0", previous: "Date | null" }))
	.handler(({ data }) => restoreNoReturn(getDb(), data.orderId, data.previous));

// Everything the invoices for orders still to ship print, in pin order so
// the stack matches what packers type. `ids` picks the orders instead,
// whether or not they still need shipping.
// Called by the invoices page once the print dialog closes, with the
// orders it held, so the next Print all skips them.
export const markInvoicesPrinted = createServerFn({ method: "POST" })
	.validator(type({ ids: "(number.integer > 0)[] > 0" }))
	.handler(async ({ data }) => {
		await getDb()
			.update(orders)
			.set({ invoicePrintedAt: new Date() })
			.where(inArray(orders.id, data.ids));
	});

export const listInvoices = createServerFn({ method: "GET" })
	.validator(type({ "ids?": "(number.integer > 0)[]" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const locationId = await shippingLocation(db);
		const [from] = locationId
			? await db.select().from(locations).where(eq(locations.id, locationId))
			: [];
		const select = (where: SQL) =>
			db
				.select({
					id: orders.id,
					name: orders.name,
					pin: orders.pin,
					placedAt: orders.placedAt,
					salesChannel: orders.salesChannel,
					customerName: orders.customerName,
					shipAddress1: orders.shipAddress1,
					shipAddress2: orders.shipAddress2,
					shipCity: orders.shipCity,
					shipRegion: orders.shipRegion,
					shipPostalCode: orders.shipPostalCode,
					shipCountry: orders.shipCountry,
					total: orders.total,
					shippingCharged: orders.shippingCharged,
					financialStatus: orders.financialStatus,
					channel: stores.channel,
					marketplaceOrderId: orders.marketplaceOrderId,
					externalId: orders.externalId,
					needsShipping,
				})
				.from(orders)
				.innerJoin(stores, eq(stores.id, orders.storeId))
				.where(where)
				.orderBy(asc(orders.pin), asc(orders.placedAt));
		// The orders picked, printed before or not, or every order still to
		// ship that hasn't been printed.
		const toShip = await select(
			data.ids
				? inArray(orders.id, data.ids)
				: sql`${needsShipping} and ${isNull(orders.invoicePrintedAt)}`,
		);
		const lines = toShip.length
			? await db
					.select({
						orderId: orderLines.orderId,
						productId: orderLines.productId,
						sku: sql<
							string | null
						>`coalesce(${products.sku}, ${orderLines.sku})`,
						title: orderLines.title,
						quantity: orderLines.quantity,
						unitPrice: orderLines.unitPrice,
						// The size or option to pick, from the catalog: channel
						// titles don't always carry it.
						variantName: products.variantName,
						weightGrams: products.weightGrams,
						imageUrl: products.imageUrl,
					})
					.from(orderLines)
					.leftJoin(products, eq(products.id, orderLines.productId))
					.where(
						and(
							inArray(
								orderLines.orderId,
								toShip.map((o) => o.id),
							),
							gt(orderLines.quantity, 0),
						),
					)
					.orderBy(orderLines.id)
			: [];
		// What's inside each set sold (kit or bundle), one level down, so the
		// invoice lists the pieces under it.
		const setIds = [
			...new Set(lines.flatMap((l) => (l.productId ? [l.productId] : []))),
		];
		const parts = setIds.length
			? await db
					.select({
						setId: productComponents.parentProductId,
						sku: products.sku,
						name: products.name,
						variantName: products.variantName,
						imageUrl: products.imageUrl,
						perSet: productComponents.quantity,
					})
					.from(productComponents)
					.innerJoin(
						products,
						eq(products.id, productComponents.componentProductId),
					)
					.where(inArray(productComponents.parentProductId, setIds))
					.orderBy(asc(products.sku))
			: [];
		const partsBy = groupBy(parts, (p) => p.setId);
		const partsOf = (productId: number | null) =>
			productId === null ? [] : (partsBy.get(productId) ?? []);
		const linesBy = groupBy(lines, (l) => l.orderId);
		const linesOf = (id: number) => linesBy.get(id) ?? [];
		const keys = new Map(toShip.map((o) => [o.id, contentsKey(linesOf(o.id))]));
		const lastPacked = await lastPackedFor(db, [...new Set(keys.values())]);
		// Any order still to ship can share the box, printed or not, so a
		// packer printing a few still hears about the rest.
		const pool = data.ids ? await select(needsShipping) : toShip;
		// Orders already holding a label can't join another box.
		const live = await liveDispatches(db, [
			...new Set([...toShip, ...pool].map((o) => o.id)),
		]);
		// Other orders to the same address that can share the box, so the
		// packer gathers them before typing the pin.
		const sharing = sharingOrders(toShip, pool, live);
		return {
			from: from
				? {
						name: from.shipFromName ?? from.name,
						lines: [
							from.address1,
							from.address2,
							cityLine(from.city, from.region, from.postalCode),
						].filter((l): l is string => !!l),
						phone: from.phone,
						email: from.email,
					}
				: null,
			invoices: toShip.map((o) => {
				const own = linesOf(o.id);
				const last = lastPacked.get(keys.get(o.id) ?? "");
				return {
					...o,
					lines: own.map((l) => ({ ...l, parts: partsOf(l.productId) })),
					shipsWith: sharing.get(o.id) ?? [],
					// What quick ship will suggest: the box and weight these exact
					// contents went out in last time, else the items' own weight.
					// Name and size apart, so the invoice can set them differently.
					box: last ? { name: last.boxName, size: boxSize(last) } : null,
					// How many boxes these contents took last time; the box and
					// weight above are the first one's.
					boxes: last?.boxes ?? 1,
					weightGrams:
						last?.weightGrams ??
						(own.every((l) => l.weightGrams !== null)
							? own.reduce((g, l) => g + (l.weightGrams ?? 0) * l.quantity, 0)
							: null),
				};
			}),
		};
	});

export type OrderRow = Awaited<ReturnType<typeof listOrders>>["orders"][number];
export type OrderDetail = Awaited<ReturnType<typeof getOrder>>;
export type ReturnsData = Awaited<ReturnType<typeof getReturns>>;
