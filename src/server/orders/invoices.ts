import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import { getDb } from "#/db/client";
import {
	locations,
	orders,
	productComponents,
	products,
	stores,
} from "#/db/schema";
import { cityLine } from "#/lib/format";
import { groupBy } from "#/lib/group-by";
import { sharingOrders } from "#/orders/invoice-index";
import { slipsOf } from "#/orders/slip";
import {
	financialStatus,
	needsPacking,
	remainingUnknown,
} from "#/orders/to-ship";
import { boxSize } from "#/shipping/box-filter";
import { contentsKey } from "#/shipping/contents";
import { liveDispatches } from "#/shipping/dispatch";
import { lastPackedFor } from "#/shipping/quick-ship";

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
					financialStatus,
					channel: stores.channel,
					marketplaceOrderId: orders.marketplaceOrderId,
					externalId: orders.externalId,
					storeId: orders.storeId,
					buyerId: orders.buyerId,
					needsPacking,
					remainingUnknown,
					fulfillmentStatus: orders.fulfillmentStatus,
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
				: sql`${needsPacking} and ${isNull(orders.invoicePrintedAt)}`,
		);
		const slips = await slipsOf(db, toShip);
		const items = [...slips.values()].flatMap((slip) => slip.items);
		// What's inside each set sold (kit or bundle), one level down, so the
		// invoice lists the pieces under it.
		const setIds = [
			...new Set(items.flatMap((l) => (l.productId ? [l.productId] : []))),
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
		const slipOf = (o: { id: number }) =>
			slips.get(o.id) ?? { items: [], subtotal: 0 };
		// What goes in the box, or null when part of it is unknown.
		const packing = (o: { id: number }) => {
			const items = slipOf(o).items;
			if (items.some((l) => l.toPack === "unknown")) return null;
			return items.flatMap((l) =>
				typeof l.toPack === "number" && l.toPack > 0
					? [{ ...l, quantity: l.toPack }]
					: [],
			);
		};
		const keys = new Map(
			toShip.flatMap((o) => {
				const packed = packing(o);
				return packed ? [[o.id, contentsKey(packed)] as const] : [];
			}),
		);
		const lastPacked = await lastPackedFor(db, [...new Set(keys.values())]);
		// Any order still to ship can share the box, printed or not, so a
		// packer printing a few still hears about the rest.
		const pool = data.ids ? await select(needsPacking) : toShip;
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
				const { items: own, subtotal } = slipOf(o);
				const packed = packing(o);
				const key = keys.get(o.id);
				const last = key === undefined ? undefined : lastPacked.get(key);
				return {
					...o,
					lines: own.map((l) => ({ ...l, parts: partsOf(l.productId) })),
					subtotal,
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
						(packed?.every((l) => l.weightGrams !== null)
							? packed.reduce(
									(g, l) => g + (l.weightGrams ?? 0) * l.quantity,
									0,
								)
							: null),
				};
			}),
		};
	});
