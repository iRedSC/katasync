import { and, eq, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	marketplaceCases,
	openCases,
	orderLines,
	orders,
	returnRequests,
	stores,
} from "#/db/schema";
import { returnPage } from "./admin-urls";
import type { CaseMoney, ObligationStage } from "./return-requests";

type Row = typeof marketplaceCases.$inferInsert;
export type MarketplaceCase = ObligationStage<Row["status"]> &
	CaseMoney & {
		kind: Row["kind"];
		externalId: string;
		orderExternalId: string | null;
		transactionId: string | null;
		returnExternalId: string | null;
		rawStatus: string;
		nextAction: string | null;
		caseRef: string | null;
		actionUrl: string | null;
		requestedAt: Date;
		problems: string[];
	};

export async function saveMarketplaceCase(
	db: Db,
	billedBy: Row["billedBy"],
	found: MarketplaceCase,
) {
	const { transactionId, returnExternalId, problems: _, ...data } = found;
	const candidates =
		found.orderExternalId || transactionId
			? await db
					.selectDistinct({ id: orders.id })
					.from(orders)
					.innerJoin(stores, eq(stores.id, orders.storeId))
					.leftJoin(orderLines, eq(orderLines.orderId, orders.id))
					.where(
						and(
							eq(stores.channel, billedBy),
							or(
								found.orderExternalId
									? or(
											eq(orders.externalId, found.orderExternalId),
											eq(orders.name, found.orderExternalId),
											eq(
												orders.marketplaceOrderId,
												`${billedBy}:${found.orderExternalId}`,
											),
										)
									: undefined,
								transactionId
									? eq(orderLines.externalId, transactionId)
									: undefined,
							),
						),
					)
					.limit(2)
			: [];
	const related = returnExternalId
		? await db
				.select({ id: returnRequests.id, orderId: returnRequests.orderId })
				.from(returnRequests)
				.where(
					and(
						eq(returnRequests.billedBy, billedBy),
						eq(returnRequests.externalId, returnExternalId),
					),
				)
				.limit(1)
		: [];
	const values = {
		...data,
		billedBy,
		orderId:
			candidates.length === 1
				? candidates[0].id
				: (related[0]?.orderId ?? null),
		relatedReturnRequestId: related[0]?.id ?? null,
		syncedAt: new Date(),
	};
	await db
		.insert(marketplaceCases)
		.values(values)
		.onConflictDoUpdate({
			target: [
				marketplaceCases.billedBy,
				marketplaceCases.kind,
				marketplaceCases.externalId,
			],
			set: values,
		});
}

export async function openMarketplaceCaseRows(db: Db) {
	const rows = await db
		.select({
			id: marketplaceCases.id,
			kind: marketplaceCases.kind,
			status: marketplaceCases.status,
			rawStatus: marketplaceCases.rawStatus,
			waitingOn: marketplaceCases.waitingOn,
			respondBy: marketplaceCases.respondBy,
			amount: marketplaceCases.amount,
			currency: marketplaceCases.currency,
			orderId: marketplaceCases.orderId,
			name: orders.name,
			channel: marketplaceCases.billedBy,
			salesChannel: orders.salesChannel,
			externalId: marketplaceCases.externalId,
			marketplaceOrderId: orders.marketplaceOrderId,
			customerName: orders.customerName,
			shipCity: orders.shipCity,
			shipRegion: orders.shipRegion,
			shipPostalCode: orders.shipPostalCode,
			placedAt: orders.placedAt,
			billedBy: marketplaceCases.billedBy,
			orderPageId: orders.externalId,
			requestedAt: marketplaceCases.requestedAt,
			actionUrl: marketplaceCases.actionUrl,
			nextAction: marketplaceCases.nextAction,
			orderExternalId: marketplaceCases.orderExternalId,
		})
		.from(openCases)
		.innerJoin(
			marketplaceCases,
			and(
				eq(openCases.source, "marketplace"),
				eq(marketplaceCases.id, openCases.id),
			),
		)
		.leftJoin(orders, eq(orders.id, marketplaceCases.orderId));
	return rows.map(({ actionUrl, orderPageId, ...row }) => ({
		...row,
		source: "marketplace" as const,
		name: row.name ?? row.orderExternalId ?? row.externalId,
		reason: row.nextAction,
		note: row.orderId === null ? "Order not imported" : null,
		answerOn: actionUrl
			? { url: actionUrl, name: "eBay" }
			: orderPageId
				? returnPage(
						{
							channel: row.billedBy,
							externalId: orderPageId,
							marketplaceOrderId: row.marketplaceOrderId,
						},
						row.billedBy,
					)
				: null,
		lines: [],
	}));
}
