import { asc, eq } from "drizzle-orm";
import { readDraft, readOrderBill } from "#/channels/shopify/draft-orders";
import { stockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import {
	repairLabor,
	repairParts,
	repairs,
	repairTools,
} from "#/db/repair-schema";
import { locations, products } from "#/db/schema";
import { cityLine } from "#/lib/format";
import { isOurs, LABOR, lineTool, TOOL_KEY, toolKey } from "./draft-lines";
import { laborVariants, shopifyVariants } from "./variants";

// A repair's printed invoice (src/routes/print/repairs.$id.tsx): each tool
// with its labor and parts, then what's for the order as a whole, then what
// was added in Shopify. Every price is Shopify's, off the draft order or
// the order it became, so the page says what the customer is charged. The
// repair's time is billed together (src/repairs/draft-lines.ts), so each
// tool's labor is its share of that by minutes, to the cent, adding up to
// what Shopify charges.

// A line Shopify charges, from a draft or an order.
export type BillLine = {
	title: string;
	quantity: number;
	variantId: string | null;
	customAttributes: { key: string; value: string | null }[];
	total: number;
};

export type Bill = {
	// The draft's name, or the order's once paid.
	name: string;
	// Ordered, so paid for at least in part.
	ordered: boolean;
	subtotal: number;
	shipping: number;
	tax: number;
	total: number;
	// What's still owed, and what was given back, as Shopify says.
	due: number;
	refunded: number;
	lines: BillLine[];
};

type Tool = {
	id: number;
	tool: string;
	serial: string | null;
	problem: string;
};
type Labor = { toolId: number | null; minutes: number; note: string };
type Part = {
	toolId: number | null;
	productId: number;
	sku: string;
	name: string;
	variantName: string | null;
	quantity: number;
};

export type InvoiceGroup = {
	// Null: the order as a whole.
	tool: Tool | null;
	labor: { minutes: number; note: string }[];
	laborMinutes: number;
	// Its share of Shopify's price for the time; null when Shopify wasn't
	// read.
	laborTotal: number | null;
	// Quantities are what Shopify bills, once read.
	parts: (Omit<Part, "toolId" | "productId"> & { total: number | null })[];
	// Lines Shopify charges the group that are neither its labor nor one of
	// its parts (a part's listing changed since), shown as Shopify has them
	// so no charge goes unlisted.
	extra: { title: string; quantity: number; total: number }[];
	subtotal: number | null;
};

// Splits an amount by weight into cents that add up to it exactly: each
// share rounded down, then the leftover cents to the largest remainders.
export function share(total: number, weights: number[]) {
	const cents = Math.round(total * 100);
	const all = weights.reduce((n, w) => n + w, 0);
	if (all === 0) return weights.map(() => 0);
	const exact = weights.map((w) => (cents * w) / all);
	const out = exact.map(Math.floor);
	let left = cents - out.reduce((n, c) => n + c, 0);
	for (const i of exact
		.map((e, i) => ({ i, r: e - Math.floor(e) }))
		.sort((a, b) => b.r - a.r)
		.map((x) => x.i)) {
		if (left <= 0) break;
		out[i]++;
		left--;
	}
	return out.map((c) => c / 100);
}

// Sorts what Shopify charges under the tools it's for. Every tool shows,
// charged or not; the order's own group only when it has something.
export function breakdown(input: {
	tools: Tool[];
	labor: Labor[];
	parts: Part[];
	// Each part's Shopify variant, by product.
	variantOf: Map<number, string>;
	// The labor product's variants.
	laborVariants: Set<string>;
	bill: Bill | null;
}) {
	const { tools, labor, parts, variantOf, laborVariants, bill } = input;
	const first = tools[0]?.id;
	const ours = bill?.lines.filter(isOurs) ?? [];
	const sum = (lines: BillLine[]) => lines.reduce((n, l) => n + l.total, 0);
	// Marked as the repair's time, or, on drafts from before it was, one of
	// the labor product's variants. The mark holds even once Shopify has
	// lost the variant.
	const isLabor = (l: BillLine) =>
		l.customAttributes.some((a) => a.key === TOOL_KEY && a.value === LABOR) ||
		(l.variantId !== null && laborVariants.has(l.variantId));
	const slots = [
		...tools.map((t) => ({ tool: t, toolId: t.id })),
		{ tool: null, toolId: null },
	].map((s) => ({ ...s, time: labor.filter((l) => l.toolId === s.toolId) }));
	const minutesOf = (time: Labor[]) => time.reduce((n, l) => n + l.minutes, 0);
	// Every labor line, whichever tool it says (older drafts billed each
	// tool's time apart), shared by minutes. With no time to share it by, it
	// shows as the order's, so no charge goes unlisted.
	const laborLines = ours.filter(isLabor);
	const timed = slots.some((s) => minutesOf(s.time) > 0);
	const shares = share(
		sum(laborLines),
		slots.map((s) => minutesOf(s.time)),
	);
	// Ours, but for no tool still on the repair: shown as the order's.
	const keys = new Set(slots.map((s) => toolKey(s.toolId)));
	const strays = ours.filter(
		(l) => !isLabor(l) && !keys.has(lineTool(l, first)),
	);
	const groups: InvoiceGroup[] = slots.flatMap(({ tool, toolId, time }, i) => {
		const key = toolKey(toolId);
		const used = parts.filter((p) => p.toolId === toolId);
		const lines = [
			...ours.filter((l) => !isLabor(l) && lineTool(l, first) === key),
			...(tool ? [] : strays),
			...(!tool && !timed ? laborLines : []),
		];
		if (!tool && time.length + used.length + lines.length === 0) return [];
		const laborTotal = timed ? shares[i] : 0;
		const matched = new Set<BillLine>();
		const shown = used.map(({ toolId: _, productId, ...p }) => {
			const variant = variantOf.get(productId);
			const line = lines.find((l) => !isLabor(l) && l.variantId === variant);
			if (line) matched.add(line);
			return {
				...p,
				quantity: line?.quantity ?? p.quantity,
				total: bill ? (line?.total ?? 0) : null,
			};
		});
		return [
			{
				tool,
				labor: time.map((l) => ({ minutes: l.minutes, note: l.note })),
				laborMinutes: minutesOf(time),
				laborTotal: bill ? laborTotal : null,
				parts: shown,
				extra: lines
					.filter((l) => !matched.has(l))
					.map((l) => ({
						title: l.title,
						quantity: l.quantity,
						total: l.total,
					})),
				subtotal: bill
					? Math.round((laborTotal + sum(lines)) * 100) / 100
					: null,
			},
		];
	});
	const added = bill?.lines.filter((l) => !isOurs(l)) ?? [];
	// An order-wide discount set in Shopify: the subtotal less the lines.
	const adjustment = bill
		? Math.round((bill.subtotal - sum(bill.lines)) * 100) / 100
		: 0;
	return {
		groups,
		added: added.map((l) => ({
			title: l.title,
			quantity: l.quantity,
			total: l.total,
		})),
		adjustment,
	};
}

type Read =
	| { kind: "none" }
	| { kind: "unreadable"; error: string }
	| { kind: "read"; bill: Bill };

// What Shopify charges the repair now: its order once paid, else its draft.
async function readBill(r: {
	orderId: string | null;
	draftOrderId: string | null;
}): Promise<Read> {
	try {
		if (r.orderId) {
			const o = await readOrderBill(r.orderId);
			if (!o) return { kind: "unreadable", error: "The order is gone" };
			if (o.lineItems.pageInfo.hasNextPage)
				return {
					kind: "unreadable",
					error: `${o.name} has more lines than can be listed`,
				};
			return {
				kind: "read",
				bill: {
					name: o.name,
					ordered: true,
					subtotal: Number(o.subtotalPriceSet.shopMoney.amount),
					shipping: Number(o.totalShippingPriceSet.shopMoney.amount),
					tax: Number(o.totalTaxSet.shopMoney.amount),
					total: Number(o.totalPriceSet.shopMoney.amount),
					due: Number(o.totalOutstandingSet.shopMoney.amount),
					refunded: Number(o.totalRefundedSet.shopMoney.amount),
					lines: o.lineItems.nodes.map((l) => ({
						title: l.title,
						quantity: l.quantity,
						variantId: l.variant?.id ?? null,
						customAttributes: l.customAttributes,
						total: Number(l.discountedTotalSet.shopMoney.amount),
					})),
				},
			};
		}
		if (!r.draftOrderId) return { kind: "none" };
		const d = await readDraft(r.draftOrderId);
		if (!d) return { kind: "unreadable", error: "The draft order is gone" };
		// Ordered since the board last looked: what the order says.
		if (d.status === "COMPLETED" && d.order)
			return readBill({ orderId: d.order.id, draftOrderId: null });
		if (d.lineItems.pageInfo.hasNextPage)
			return {
				kind: "unreadable",
				error: `${d.name} has more lines than can be listed`,
			};
		const total = Number(d.totalPriceSet.shopMoney.amount);
		return {
			kind: "read",
			bill: {
				name: d.name,
				ordered: false,
				subtotal: Number(d.subtotalPriceSet.shopMoney.amount),
				shipping: Number(d.totalShippingPriceSet.shopMoney.amount),
				tax: Number(d.totalTaxSet.shopMoney.amount),
				total,
				due: total,
				refunded: 0,
				lines: d.lineItems.nodes.map((l) => ({
					title: l.title,
					quantity: l.quantity,
					variantId: l.variant?.id ?? null,
					customAttributes: l.customAttributes,
					total: Number(l.discountedTotalSet.shopMoney.amount),
				})),
			},
		};
	} catch (error) {
		return {
			kind: "unreadable",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

// Where walk-ins come: the counter, else the store, else the warehouse.
async function shop(db: Db) {
	const at = await stockLocations(db);
	const id = at.pos ?? at.store ?? at.shipping;
	if (id === null) return null;
	const [l] = await db.select().from(locations).where(eq(locations.id, id));
	if (!l) return null;
	return {
		name: l.shipFromName ?? l.name,
		lines: [
			l.address1,
			l.address2,
			cityLine(l.city, l.region, l.postalCode),
		].filter((x): x is string => !!x),
		phone: l.phone,
		email: l.email,
	};
}

export async function repairInvoice(db: Db, id: number) {
	const [r] = await db
		.select({
			id: repairs.id,
			kind: repairs.kind,
			status: repairs.status,
			customerName: repairs.customerName,
			customerPhone: repairs.customerPhone,
			customerEmail: repairs.customerEmail,
			draftOrderId: repairs.draftOrderId,
			orderId: repairs.orderId,
			createdAt: repairs.createdAt,
		})
		.from(repairs)
		.where(eq(repairs.id, id));
	if (!r) return null;
	const tools = await db
		.select({
			id: repairTools.id,
			tool: repairTools.tool,
			serial: repairTools.serial,
			problem: repairTools.problem,
		})
		.from(repairTools)
		.where(eq(repairTools.repairId, id))
		.orderBy(asc(repairTools.id));
	const labor = await db
		.select({
			toolId: repairLabor.toolId,
			minutes: repairLabor.minutes,
			note: repairLabor.note,
		})
		.from(repairLabor)
		.where(eq(repairLabor.repairId, id))
		.orderBy(asc(repairLabor.id));
	const parts = await db
		.select({
			toolId: repairParts.toolId,
			productId: repairParts.productId,
			sku: products.sku,
			name: products.name,
			variantName: products.variantName,
			quantity: repairParts.quantity,
		})
		.from(repairParts)
		.innerJoin(products, eq(products.id, repairParts.productId))
		.where(eq(repairParts.repairId, id))
		.orderBy(asc(repairParts.id));
	const [variantOf, read, from] = await Promise.all([
		shopifyVariants(
			db,
			parts.map((p) => p.productId),
		),
		r.kind === "bench" ? Promise.resolve<Read>({ kind: "none" }) : readBill(r),
		shop(db),
	]);
	// Labor lines are told apart by the labor product's variants.
	let priced: Read = read;
	let labored = new Set<string>();
	if (read.kind === "read")
		try {
			labored = new Set((await laborVariants()).map((v) => v.variantId));
		} catch (error) {
			priced = {
				kind: "unreadable",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	const bill = priced.kind === "read" ? priced.bill : null;
	const { draftOrderId: _d, orderId: _o, ...repair } = r;
	return {
		repair,
		from,
		bill: bill && {
			name: bill.name,
			ordered: bill.ordered,
			subtotal: bill.subtotal,
			shipping: bill.shipping,
			tax: bill.tax,
			total: bill.total,
			due: bill.due,
			refunded: bill.refunded,
		},
		// Why there are no prices, when there aren't.
		unpriced: priced.kind === "unreadable" ? priced.error : null,
		...breakdown({
			tools,
			labor,
			parts,
			variantOf,
			laborVariants: labored,
			bill,
		}),
	};
}
export type RepairInvoice = NonNullable<
	Awaited<ReturnType<typeof repairInvoice>>
>;
