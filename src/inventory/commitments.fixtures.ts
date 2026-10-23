import { and, eq, sql } from "drizzle-orm";
import type { StockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import {
	activateCommittedMode,
	planActivation,
	type Resolution,
} from "./commitments-activation";
import { postMovements } from "./ledger";
import { getAvailability } from "./availability";
import { onlineStock } from "./online-stock";

export const stockFrom = new Date("2026-10-01T00:00:00Z");

export function channelOrder(extra: Partial<ChannelOrder> = {}): ChannelOrder {
	return {
		externalId: "gid://shopify/Order/1",
		name: "#1001",
		salesChannel: "Online Store",
		marketplaceOrderId: null,
		placedAt: new Date("2026-10-05T12:00:00Z"),
		cancelledAt: null,
		fulfillmentStatus: "UNFULFILLED",
		fulfilledByChannel: false,
		soldInStore: false,
		financialStatus: "PAID",
		customerName: "Pat Doe",
		shipCity: "Harrisburg",
		shipRegion: "PA",
		shipCountry: "US",
		shipAddress1: "1 Main St",
		shipAddress2: null,
		shipPostalCode: "17101",
		shipPhone: null,
		total: 50,
		shippingCharged: 10,
		tax: { remittedBy: "seller", lines: [] },
		sourceUpdatedAt: new Date("2026-10-05T12:00:00Z"),
		lines: [
			{
				externalId: "line-1",
				listingExternalId: null,
				sku: "WRENCH",
				title: "Wrench",
				quantity: 3,
				unitPrice: 20,
			},
		],
		...extra,
	};
}

export async function quantityWorld(db: Db) {
	const [warehouse, retail] = await db
		.insert(schema.locations)
		.values([
			{ name: "Warehouse", kind: "owned" },
			{ name: "Retail", kind: "retail", posPrimary: true },
		])
		.returning();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify", stockFrom })
		.returning();
	const from: StockLocations = {
		shipping: warehouse.id,
		store: retail.id,
		pos: retail.id,
		storeKeeps: 0,
	};
	return {
		warehouse: warehouse.id,
		retail: retail.id,
		from,
		ingest: (order: ChannelOrder) =>
			ingestOrder(db, { id: store.id, stockFrom }, order, from),
		stock: (productId: number, locationId: number, delta: number) =>
			postMovements(db, {
				lines: [{ productId, locationId, delta, reason: "receipt" }],
			}),
		onHand: async (productId: number, locationId: number) => {
			const rows = await db
				.select({ onHand: schema.stockLevels.onHand })
				.from(schema.stockLevels)
				.where(
					sql`${schema.stockLevels.productId} = ${productId} and ${schema.stockLevels.locationId} = ${locationId}`,
				);
			return rows[0]?.onHand ?? 0;
		},
		available: async (productId: number) =>
			(await getAvailability(db, [productId], await onlineStock(db))).get(
				productId,
			) ?? 0,
		lineId: async (orderId: number, externalId = "line-1") => {
			const [row] = await db
				.select({ id: schema.orderLines.id })
				.from(schema.orderLines)
				.where(
					and(
						eq(schema.orderLines.orderId, orderId),
						eq(schema.orderLines.externalId, externalId),
					),
				);
			if (!row) throw new Error(`No line ${externalId}`);
			return row.id;
		},
	};
}

export async function activate(db: Db, resolutions: Resolution[] = []) {
	const plan = await planActivation(db, { resolutions });
	return activateCommittedMode(db, {
		fingerprint: plan.fingerprint,
		resolutions,
		oldWorkersDrained: true,
	});
}
