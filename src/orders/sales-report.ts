import { sql } from "drizzle-orm";
import { SHOP_APP } from "#/channels/shopify/channel-order";
import type { Db } from "#/db/client";
import { US_STATES } from "#/lib/places";
import { TIME_ZONE } from "./profit";

// Sales and sales tax for the accountant, one calendar month at a time in
// shop time, by the date each order was placed. Every order not cancelled
// counts, shipped or not, with its refunds and charges as known now. Built
// on order_profit (drizzle/0060_awaiting_return.sql) and order_taxes.

// A calendar month, "2026-09" in addresses. month is 1 to 12.
export type Period = { year: number; month: number };

const PERIOD = /^(\d{4})-(\d{2})$/;

export function parsePeriod(text: string): Period | null {
	const m = PERIOD.exec(text);
	if (!m) return null;
	const month = Number(m[2]);
	return month >= 1 && month <= 12 ? { year: Number(m[1]), month } : null;
}

export function periodText(p: Period) {
	return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

// "May 2026".
export function periodName(p: Period) {
	return `${MONTHS[p.month - 1]} ${p.year}`;
}

// "May 1 to May 31, 2026", the days the month covers.
export function periodDays(p: Period) {
	const lastDay = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
	const name = MONTHS[p.month - 1];
	return `${name} 1 to ${name} ${lastDay}, ${p.year}`;
}

// The month `step` months on.
export function shiftPeriod(p: Period, step: number): Period {
	const index = p.year * 12 + p.month - 1 + step;
	return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

// The last month that's over, the one an accountant usually asks for.
export function lastMonth(now = new Date()): Period {
	const local = new Date(now.toLocaleString("en-US", { timeZone: TIME_ZONE }));
	return shiftPeriod(
		{ year: local.getFullYear(), month: local.getMonth() + 1 },
		-1,
	);
}

// The month's bounds as SQL: shop-local midnights, as instants.
function bounds(p: Period) {
	const start = `${periodText(p)}-01 00:00`;
	const tz = sql.raw(`'${TIME_ZONE}'`);
	return {
		start: sql`(${start}::timestamp at time zone ${tz})`,
		end: sql`((${start}::timestamp + interval '1 month') at time zone ${tz})`,
	};
}

export type ChannelRow = {
	// The marketplace; for Shopify, "retail" for sales rung up in the store
	// and "shop" for Shopify's Shop app.
	source: "shopify" | "retail" | "shop" | "amazon" | "ebay" | "tiktok";
	orders: number;
	itemSales: number;
	shipping: number;
	// What buyers paid before tax: items and shipping.
	grossSales: number;
	// Tax the marketplace collected and paid to the state itself.
	marketplaceTax: number;
	// Tax we collected and owe.
	ourTax: number;
	refunds: number;
	fees: number;
	labels: number;
	adjustments: number;
	// What's left of gross sales after refunds and what the marketplace kept,
	// before the cost of the goods.
	net: number;
	// Orders whose fees are still katasync's estimate, not the marketplace's.
	feesEstimated: number;
	// Orders whose tax hasn't been read yet.
	taxUnknown: number;
};

export type JurisdictionRow = {
	// Where the order went: "US", or the country it was shipped to, whose tax
	// Shopify often just calls "Tax".
	country: string;
	jurisdiction: string;
	rate: number | null;
	orders: number;
	// Sales (items and shipping) on orders taxed here.
	taxableSales: number;
	tax: number;
};

export type StateRow = {
	// Where the sale is taxed. Shipped orders: where the goods went, a country
	// code ("IE") and, in the US, a state. Sales in the store and orders with
	// no address (picked up, or a draft order) are taxed where the sale
	// happened, which may not be our state (a show out of state): the state
	// named by the tax Shopify charged, else ours. State is null outside the
	// US, or when no state is known.
	country: string;
	state: string | null;
	how: "in_store" | "shipped" | "no_address";
	orders: number;
	// Orders Shopify charged tax on.
	taxedOrders: number;
	sales: number;
	tax: number;
};

type Rows<T> = { rows: T[] };

// Our own sales Shopify charged tax on outside our state, other than sales
// made in person: those are at shows, under a transient vendor's license for
// that state. Tax on a shipped or picked-up order outside our state means
// Shopify's tax settings collect where we don't file, so someone has to look.
export function taxedElsewhere(
	r: Pick<StateRow, "country" | "state" | "how" | "tax">,
	homeState: string | null,
) {
	return (
		r.tax !== 0 &&
		r.how !== "in_store" &&
		homeState !== null &&
		(r.country !== "US" || r.state !== homeState)
	);
}

export async function salesReport(db: Db, period: Period) {
	const { start, end } = bounds(period);
	// Orders placed in the period, with where they were sold and their tax.
	const placed = sql`
		placed as (
			select p.*, o.sold_in_store, o.ship_region, o.ship_country, o.tax_remitted_by,
				case when p.sold_on = 'shopify' and o.sold_in_store then 'retail'
					when p.sold_on = 'shopify' and o.sales_channel = ${SHOP_APP} then 'shop'
					else p.sold_on::text end as source,
				coalesce((select sum(t.amount) from order_taxes t
					where t.order_id = o.id), 0) as tax
			from order_profit p
			join orders o on o.id = p.order_id
			where p.placed_at >= ${start} and p.placed_at < ${end}
		)`;

	const channels = (await db.execute(sql`
		with ${placed}
		select source,
			count(*)::int as orders,
			sum(revenue)::float8 as "itemSales",
			sum(shipping_charged)::float8 as shipping,
			sum(revenue + shipping_charged)::float8 as "grossSales",
			coalesce(sum(tax) filter (where tax_remitted_by = 'marketplace'), 0)::float8 as "marketplaceTax",
			coalesce(sum(tax) filter (where tax_remitted_by = 'seller'), 0)::float8 as "ourTax",
			sum(refunds)::float8 as refunds,
			sum(fees)::float8 as fees,
			sum(labels)::float8 as labels,
			sum(adjustments)::float8 as adjustments,
			sum(revenue + shipping_charged - refunds - fees - labels - adjustments)::float8 as net,
			(count(*) filter (where fees_status = 'estimated'))::int as "feesEstimated",
			(count(*) filter (where tax_remitted_by is null))::int as "taxUnknown"
		from placed
		group by source
		order by sum(revenue + shipping_charged) desc
	`)) as unknown as Rows<ChannelRow>;

	const jurisdictions = (await db.execute(sql`
		with ${placed}
		select case when p.sold_in_store then 'US'
				else coalesce(upper(nullif(btrim(p.ship_country), '')), 'US') end as country,
			t.jurisdiction, t.rate::float8 as rate,
			count(distinct p.order_id)::int as orders,
			sum(p.revenue + p.shipping_charged)::float8 as "taxableSales",
			sum(t.amount)::float8 as tax
		from placed p
		join order_taxes t on t.order_id = p.order_id
		where p.tax_remitted_by = 'seller'
		group by 1, t.jurisdiction, t.rate
		order by sum(t.amount) desc
	`)) as unknown as Rows<JurisdictionRow>;

	// Who the report is for, and the state we're in: the retail store's, else
	// the warehouse's. The name is the one invoices go out under.
	const business = (await db.execute(sql`
		select
			(select coalesce(ship_from_name, name) from locations
				where kind <> 'fba' order by ship_from_name is null, kind = 'retail' limit 1) as name,
			(select upper(btrim(region)) from locations
				where kind <> 'fba' and nullif(btrim(region), '') is not null
				order by kind = 'retail' desc limit 1) as "homeState"
	`)) as unknown as Rows<{ name: string | null; homeState: string | null }>;
	const { name, homeState } = business.rows[0] ?? {
		name: null,
		homeState: null,
	};

	// Our own sales by state, taxed or not, so in-state taxable sales sit
	// beside the out-of-state ones Shopify charged no tax on.
	// Shopify names a state's own tax "<State> State Tax".
	const stateTaxes = sql.join(
		Object.entries(US_STATES).map(
			([code, stateName]) => sql`(${code}, ${`${stateName} State Tax`})`,
		),
		sql`, `,
	);
	const states = (await db.execute(sql`
		with ${placed},
		state_taxes(code, jurisdiction) as (values ${stateTaxes}),
		sited as (
			select p.*,
				case when sold_in_store then 'in_store'
					when nullif(btrim(ship_region), '') is null then 'no_address'
					else 'shipped' end as how,
				(select st.code from order_taxes t
					join state_taxes st on st.jurisdiction = t.jurisdiction
					where t.order_id = p.order_id limit 1) as taxed_in
			from placed p
			where tax_remitted_by = 'seller'
		)
		select
			case when how = 'shipped' then coalesce(upper(nullif(btrim(ship_country), '')), 'US')
				else 'US' end as country,
			case when how <> 'shipped' then coalesce(taxed_in, ${homeState}::text)
				when coalesce(upper(nullif(btrim(ship_country), '')), 'US') = 'US'
					then upper(btrim(ship_region))
				end as state,
			how,
			count(*)::int as orders,
			(count(*) filter (where tax <> 0))::int as "taxedOrders",
			sum(revenue + shipping_charged)::float8 as sales,
			sum(tax)::float8 as tax
		from sited
		group by 1, 2, 3
		order by sum(revenue + shipping_charged) desc
	`)) as unknown as Rows<StateRow>;

	// Channels whose orders in katasync start after the period does: it
	// fetched only so far back when the channel was connected, so their sales
	// before then are missing here, not zero.
	const partial = (await db.execute(sql`
		select sold_on as channel, min(placed_at) as "firstOrder"
		from order_profit
		group by sold_on
		having min(placed_at) > ${start}
		order by 2
	`)) as unknown as Rows<{
		channel: "shopify" | "amazon" | "ebay" | "tiktok";
		firstOrder: string;
	}>;

	return {
		business: { name, homeState },
		partial: partial.rows.map((r) => ({
			channel: r.channel,
			firstOrder: new Date(r.firstOrder),
		})),
		channels: channels.rows,
		jurisdictions: jurisdictions.rows,
		states: states.rows,
		taxedElsewhere: states.rows.filter((r) => taxedElsewhere(r, homeState)),
	};
}

export type SalesReport = Awaited<ReturnType<typeof salesReport>>;
