// Reads sales tax for orders synced before katasync read it, from each
// marketplace, and saves only that: nothing else on the order changes and no
// stock moves. Orders the marketplace no longer has are listed and keep no
// tax, so the report can show them as unknown rather than as untaxed. Safe to
// stop and run again; it picks up whatever is still missing. Without --write
// it only counts what's missing.
//
//   pnpm tax:backfill            # how many orders, per channel
//   pnpm tax:backfill --write
//   pnpm tax:backfill --write --channel ebay   # one marketplace only
//   pnpm tax:backfill --write --channel shopify --reread
//                        # read orders again too, after a rule changes
import { actAsScript } from "#/audit/script";
import { type } from "arktype";
import { and, eq, isNull } from "drizzle-orm";
import { amazonTax, orderItems } from "#/channels/amazon";
import { accessToken, API as EBAY, ebayOrder, ebayTax } from "#/channels/ebay";
import { shopifyTax } from "#/channels/shopify/channel-order";
import { shopifyQuery } from "#/channels/shopify/client";
import { orderNode } from "#/channels/shopify/order-shapes";
import {
	detailPage,
	shopCipher,
	tiktokApi,
	tiktokTax,
} from "#/channels/tiktok";
import { getDb } from "#/db/client";
import { orders, stores } from "#/db/schema";
import { type OrderTax, saveTax } from "#/orders/tax";

actAsScript("backfill-tax");

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const write = process.argv.includes("--write");
const only = process.argv[process.argv.indexOf("--channel") + 1];
const reread = process.argv.includes("--reread");
const db = getDb();
type Channel = (typeof stores.$inferSelect)["channel"];

// Each channel reads up to 50 orders at a time, keyed by their own IDs.
const BATCH = 50;
const readers: Record<
	Channel,
	(ids: string[]) => Promise<Map<string, OrderTax>>
> = {
	async shopify(ids) {
		const { nodes } = type({
			nodes: type(
				orderNode.pick(
					"id",
					"tags",
					"currentTaxLines",
					"channelInformation",
					"app",
					"sourceName",
					"merchantOfRecordApp",
				),
			)
				.or("null")
				.array(),
		}).assert(
			await shopifyQuery(
				`query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order {
					id tags sourceName app { name } merchantOfRecordApp { name }
					channelInformation { channelDefinition { channelName } }
					currentTaxLines { title rate priceSet { shopMoney { amount } } }
				} } }`,
				{ ids },
			),
		);
		return new Map(
			nodes.flatMap((o) => (o ? [[o.id, shopifyTax(o)] as const] : [])),
		);
	},
	async amazon(ids) {
		// Amazon has no batch read for items; one order at a time, at its pace.
		const found = new Map<string, OrderTax>();
		for (const id of ids) found.set(id, amazonTax(await orderItems(id)));
		return found;
	},
	async ebay(ids) {
		const url = `${EBAY}/sell/fulfillment/v1/order?orderIds=${encodeURIComponent(ids.join(","))}`;
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${await accessToken()}` },
		});
		if (!response.ok)
			throw new Error(
				`eBay answered ${response.status}: ${await response.text()}`,
			);
		const page = type({ "orders?": ebayOrder.array() }).assert(
			await response.json(),
		);
		return new Map((page.orders ?? []).map((o) => [o.orderId, ebayTax(o)]));
	},
	async tiktok(ids) {
		const details = detailPage.assert(
			await tiktokApi("/order/202309/orders", {
				shop_cipher: await shopCipher(),
				ids: ids.join(","),
			}),
		);
		return new Map(
			(details.orders ?? []).map((o) => [o.id, tiktokTax(o.payment)]),
		);
	},
};

const missing = await db
	.select({
		id: orders.id,
		externalId: orders.externalId,
		name: orders.name,
		channel: stores.channel,
	})
	.from(orders)
	.innerJoin(stores, eq(stores.id, orders.storeId))
	.where(
		and(
			reread ? undefined : isNull(orders.taxRemittedBy),
			process.argv.includes("--channel")
				? eq(stores.channel, only as Channel)
				: undefined,
		),
	)
	.orderBy(orders.placedAt);

const byChannel = new Map<Channel, typeof missing>();
for (const o of missing)
	byChannel.set(o.channel, [...(byChannel.get(o.channel) ?? []), o]);
for (const [channel, rows] of byChannel)
	console.log(
		`${channel}: ${rows.length} orders ${reread ? "to read again" : "without tax"}`,
	);
if (!write) {
	if (missing.length > 0) console.log("Run with --write to read their tax.");
	process.exit(0);
}

const gone: string[] = [];
for (const [channel, rows] of byChannel) {
	let saved = 0;
	for (let i = 0; i < rows.length; i += BATCH) {
		const batch = rows.slice(i, i + BATCH);
		const found = await readers[channel](batch.map((r) => r.externalId));
		for (const row of batch) {
			const tax = found.get(row.externalId);
			if (!tax) {
				gone.push(`${channel} ${row.name}`);
				continue;
			}
			await db.transaction(async (tx) => {
				// A sync that read the order meanwhile has the newer answer.
				const [still] = await tx
					.select({ id: orders.id })
					.from(orders)
					.where(
						and(
							eq(orders.id, row.id),
							reread ? undefined : isNull(orders.taxRemittedBy),
						),
					)
					.for("update");
				if (still) await saveTax(tx, row.id, tax);
			});
			saved++;
		}
		console.log(`${channel}: ${saved} of ${rows.length}`);
	}
}
if (gone.length > 0) {
	console.log(`${gone.length} orders the marketplace no longer has:`);
	for (const g of gone) console.log(`  ${g}`);
}
