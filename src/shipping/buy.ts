import { eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	dispatches,
	dispatchLines,
	dispatchOrders,
	type PreparedBox,
	packages,
	shipments,
} from "#/db/schema";
import { labelSource } from "#/orders/fulfillment";
import { shipAddresses } from "./addresses";
import { destinationOf } from "./destination";
import {
	assertTogether,
	lockOnOwnConnection,
	type OrderLocker,
} from "./dispatch";
import { ebayAssertAsPacked } from "./ebay-handoff";
import { type Label, LabelRefused, outcomeOf } from "./label-attempt-state";
import { beginAttempt, recordBought, settleWithout } from "./label-attempts";
import {
	assertAsPacked,
	byLine,
	type LineToPack,
	linesToPack,
	packedOf,
	unmappable,
} from "./packed";
import { overShown } from "./price-check";
import { signatureRequired } from "./quick-ship";
import {
	type AccountReads,
	buyLabel,
	getRate,
	getRates,
	refundLabel,
	shippoIsTest,
} from "./shippo";
import { tiktokBuyLabel, tiktokOrderId, tiktokOrderUnits } from "./tiktok";
import { unitsToBuy } from "./tiktok-units";

// The outside calls, passed in so tests can stand in for Shippo, TikTok,
// and the order locks.
export type BuyOutside = {
	lock: OrderLocker;
	getRates: typeof getRates;
	getRate: typeof getRate;
	buyLabel: typeof buyLabel;
	refund: typeof refundLabel;
	tiktokBuy: typeof tiktokBuyLabel;
	tiktokUnits: typeof tiktokOrderUnits;
	ebayCheck: typeof ebayAssertAsPacked;
	isTest: () => boolean;
};

export const liveBuy: BuyOutside = {
	lock: lockOnOwnConnection,
	getRates,
	getRate,
	buyLabel,
	refund: refundLabel,
	tiktokBuy: tiktokBuyLabel,
	tiktokUnits: tiktokOrderUnits,
	ebayCheck: ebayAssertAsPacked,
	isTest: shippoIsTest,
};

export type BoxPlan = {
	packageId: number | null;
	lengthMm: number;
	widthMm: number;
	heightMm: number;
	weightGrams: number;
	insureAmount: number | null;
	// Aerosols inside: ground services only, and the label prints with the
	// Limited Quantity mark (see hazmat.ts).
	hazmat: boolean;
};

// The service picked in quick ship. Only which service: the price and the
// rate bought are the seller's, quoted again here for these exact orders and
// boxes. `id` is TikTok's service id (TikTok quotes by order itself).
// `total` is the price on screen for every box together: the most the buy
// may spend.
export type ServiceChoice = {
	carrier: string;
	service: string;
	id: string;
	total: number;
};

// Most boxes one send could need; more is almost surely a mistake.
export const MAX_BOXES = 10;

type Shipment = typeof shipments.$inferSelect;

export type Bought = {
	dispatchId: number;
	boxes: Shipment[];
	// Why the purchase stopped part way, with what was bought refunded.
	failed: string | null;
	// A box whose purchase got no clear answer, so it may have been charged:
	// the orders can't get a new label until it's checked (label-attempts.ts).
	unsure: string | null;
};

// Buys one label per box for these orders, all with one service, as one
// dispatch. The orders' locks are held throughout, and none may already
// have a live dispatch, so a double press or two people can't buy twice.
//
// Each box is priced again here from the orders' own address and the box's
// own size, so a stale or mismatched quote from the browser can't be bought.
// Each purchase is saved before the provider is asked and settled from its
// answer (label-attempts.ts), and the records commit as they go (see
// lockOnOwnConnection), so nothing paid for can be rolled back or bought
// twice. If a later box is refused, the ones already bought are refunded and
// the failure is returned; the dispatch never counts as bought, so it can't
// send tracking, only be voided. A box with no clear answer stops the
// purchase with nothing refunded: checking it settles the dispatch.
//
// What's packed is checked against the orders as quick ship showed them
// (contentsKey), then kept with the dispatch as its contents.
export async function buyDispatch(
	db: Db,
	input: {
		orderIds: number[];
		contentsKey: string;
		boxes: BoxPlan[];
		choice: ServiceChoice;
		// Asked for in quick ship. Orders that need one get one regardless.
		signature: boolean;
		// Whether these boxes become the default for these contents.
		setsDefault: boolean;
	},
	outside: BuyOutside = liveBuy,
): Promise<Bought> {
	const { boxes, choice } = input;
	if (boxes.length === 0) throw new Error("No boxes to ship");
	if (boxes.length > MAX_BOXES) {
		throw new Error(`At most ${MAX_BOXES} boxes in one shipment`);
	}
	return outside.lock(input.orderIds, async () => {
		const list = await assertTogether(db, input.orderIds);
		// The pin's order is the destination, as in the preview. Named by ID,
		// since the query's own order says nothing about it.
		const lead = list.find((o) => o.id === input.orderIds[0]);
		if (!lead) throw new Error("One of these orders no longer exists");
		const tiktok = labelSource(lead) === "tiktok";
		// TikTok sells one label per package, for one order or several
		// combined; splitting an order into boxes happens in Seller Center.
		if (tiktok && boxes.length > 1) {
			throw new Error(
				"TikTok: one box per label. Split it in TikTok Seller Center.",
			);
		}
		// Anything that could stop a record being saved is checked before
		// money is spent.
		const lines = await linesToPack(db, input.orderIds);
		assertAsPacked(lines, input.contentsKey);
		const unitIds = await assertMarketplacesAsPacked(
			list,
			lines,
			tiktok,
			outside,
		);
		await assertBoxesExist(db, boxes);
		const signature =
			!tiktok && (input.signature || signatureRequired(list) !== null);
		// TikTok's one box is quoted again as it's bought, and refused there
		// if above the shown total (tiktokBuyLabel).
		const rates = tiktok
			? []
			: await quoteEach(db, lead.id, boxes, choice, signature, outside);
		// Every box confirmed before the first is bought, so a price that rose
		// since the screen showed it stops the buy with nothing spent.
		const rose = overShown(
			rates.map((r) => r.cost),
			choice.total,
		);
		if (rose) throw new Error(rose);

		const dispatchId = await db.transaction(async (tx) => {
			const [dispatch] = await tx
				.insert(dispatches)
				.values({
					contentsKey: input.contentsKey,
					contents: "packed",
					boxCount: boxes.length,
					setsDefault: input.setsDefault,
				})
				.returning();
			await tx
				.insert(dispatchOrders)
				.values(list.map((o) => ({ dispatchId: dispatch.id, orderId: o.id })));
			await tx
				.insert(dispatchLines)
				.values(lines.map((l) => ({ ...l, dispatchId: dispatch.id })));
			return dispatch.id;
		});

		const bought: Shipment[] = [];
		for (const [i, plan] of boxes.entries()) {
			const box = {
				dispatchId,
				packageId: plan.packageId,
				lengthMm: plan.lengthMm,
				widthMm: plan.widthMm,
				heightMm: plan.heightMm,
				weightGrams: plan.weightGrams,
				hazmat: plan.hazmat,
			};
			const prepared: PreparedBox = tiktok
				? {
						...box,
						provider: "tiktok",
						carrier: choice.carrier,
						service: choice.service,
						serviceName: choice.service,
						cost: choice.total,
						insuredAmount: null,
						signature: false,
						test: false,
					}
				: {
						...box,
						provider: "shippo",
						carrier: rates[i].carrier,
						carrierToken: rates[i].carrierToken ?? null,
						service: rates[i].service,
						serviceName: rates[i].serviceName,
						cost: rates[i].cost,
						insuredAmount: plan.insureAmount,
						signature,
						test: outside.isTest(),
					};
			const attempt = await beginAttempt(db, {
				dispatchId,
				boxIndex: i,
				provider: tiktok ? "tiktok" : "shippo",
				rateId: tiktok ? choice.id : rates[i].id,
				unitIds,
				box: prepared,
			});
			const of = `Box ${i + 1} of ${boxes.length}`;
			let saved: Shipment;
			try {
				saved = await purchase(db, attempt, prepared, {
					tiktokOrderIds: tiktok
						? [...new Set(input.orderIds)].map((id) =>
								tiktokOrderId(
									list.find((o) => o.id === id)?.marketplaceOrderId ?? null,
								),
							)
						: null,
					plan,
					choice,
					rateId: rates[i]?.id,
					outside,
				});
			} catch (err) {
				const why = err instanceof Error ? err.message : String(err);
				if (outcomeOf(err) === "unknown") {
					await settleWithout(db, attempt, "unknown", { error: why }).catch(
						() => {},
					);
					return {
						dispatchId,
						boxes: bought,
						failed: `${of}: no clear answer from ${tiktok ? "TikTok" : "Shippo"} (${why}), so it may have been bought. Check it on the order page before buying again.`,
						unsure: attempt.id,
					};
				}
				await settleWithout(db, attempt, "failed", { error: why });
				// Nothing bought yet: nothing to keep, so the empty dispatch
				// stays behind unused (it never counts as live).
				if (bought.length === 0) throw err;
				const after = await refundAll(db, bought, outside);
				const stillLive = after.filter((b) => !b.voidedAt).length;
				if (stillLive === 0) {
					await db
						.update(dispatchOrders)
						.set({ reversedAt: new Date() })
						.where(eq(dispatchOrders.dispatchId, dispatchId));
				}
				return {
					dispatchId,
					boxes: after,
					failed: `${of} wasn't bought (${why}). ${
						stillLive === 0
							? "The labels already bought were refunded; press again to retry."
							: `${stillLive} label${stillLive === 1 ? "" : "s"} already bought couldn't be refunded; void ${stillLive === 1 ? "it" : "them"} on the order page.`
					}`,
					unsure: null,
				};
			}
			bought.push(saved);
		}
		return { dispatchId, boxes: bought, failed: null, unsure: null };
	});
}

// What each order's marketplace still has to ship must be exactly what was
// packed, asked of eBay and TikTok themselves before money is spent (Shopify
// is asked at handoff, where its fulfillment names each quantity). Returns
// the TikTok units the label is for, every order's, or null for a Shippo
// label.
async function assertMarketplacesAsPacked(
	list: Awaited<ReturnType<typeof assertTogether>>,
	lines: LineToPack[],
	tiktok: boolean,
	outside: BuyOutside,
): Promise<string[] | null> {
	let unitIds: string[] | null = null;
	for (const order of list) {
		const to = destinationOf(order, [tiktok ? "tiktok" : "shippo"]);
		const packed = packedOf(lines, order.id);
		if (to.kind === "hold") throw unmappable(to.why);
		if (to.kind === "ebay") {
			await outside.ebayCheck(order.externalId, byLine(packed));
		}
		if (to.kind === "tiktok") {
			unitIds = [
				...(unitIds ?? []),
				...unitsToBuy(
					await outside.tiktokUnits(to.orderId),
					packed,
					to.relayed,
				),
			];
		}
	}
	return unitIds;
}

// Pays for one box's label and records it. A refusal is a LabelRefused;
// anything else thrown may have come after the charge. A label paid for but
// not saved is refunded where it can be (a refusal then, since nothing is
// left charged); if not, it stays unknown, and checking finds and records
// it.
async function purchase(
	db: Db,
	attempt: Awaited<ReturnType<typeof beginAttempt>>,
	prepared: PreparedBox,
	ctx: {
		// Every order in the box, the pin's first.
		tiktokOrderIds: string[] | null;
		plan: BoxPlan;
		choice: ServiceChoice;
		rateId: string | undefined;
		outside: BuyOutside;
	},
): Promise<Shipment> {
	const { outside } = ctx;
	let label: Label;
	let overrides: Partial<PreparedBox> = {};
	if (attempt.provider === "tiktok") {
		if (!attempt.unitIds || !ctx.tiktokOrderIds?.length) {
			throw new LabelRefused("No TikTok units to buy");
		}
		const bought = await outside.tiktokBuy(
			ctx.tiktokOrderIds,
			ctx.plan,
			ctx.choice.id,
			attempt.unitIds,
			ctx.choice.total,
		);
		label = {
			externalId: bought.packageId,
			trackingNumber: null,
			trackingUrl: null,
			// TikTok's links expire; label-file.ts fetches by package.
			labelUrl: null,
			voided: null,
		};
		overrides = {
			carrier: bought.rate.carrier,
			service: bought.rate.service,
			serviceName: bought.rate.serviceName,
			cost: bought.rate.cost,
		};
	} else {
		if (!ctx.rateId) throw new LabelRefused("No rate to buy");
		const bought = await outside.buyLabel(ctx.rateId, attempt.id);
		label = {
			externalId: bought.id,
			trackingNumber: bought.trackingNumber,
			trackingUrl: bought.trackingUrl,
			labelUrl: bought.labelUrl,
			voided: null,
		};
	}
	try {
		return (await recordBought(db, attempt, label, overrides)).shipment;
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		if (prepared.provider === "shippo") {
			const refunded = await outside
				.refund(label.externalId)
				.then(() => true)
				.catch(() => false);
			if (refunded) {
				throw new LabelRefused(
					`A label was bought but couldn't be saved (${why}); it was refunded`,
				);
			}
		}
		throw new Error(
			`A label was bought but couldn't be saved (${why}); check it to record it`,
		);
	}
}

async function assertBoxesExist(db: Db, boxes: BoxPlan[]) {
	const ids = [
		...new Set(
			boxes.flatMap((b) => (b.packageId === null ? [] : [b.packageId])),
		),
	];
	if (ids.length === 0) return;
	const found = await db
		.select({ id: packages.id })
		.from(packages)
		.where(inArray(packages.id, ids));
	if (found.length !== ids.length) {
		throw new Error("A box was deleted from Settings; choose it again");
	}
}

// Prices every box again from the orders' address and picks the chosen
// service for each; the cheapest if the carrier offers it twice.
async function quoteEach(
	db: Db,
	orderId: number,
	boxes: BoxPlan[],
	choice: ServiceChoice,
	signature: boolean,
	outside: BuyOutside,
): Promise<Awaited<ReturnType<typeof getRate>>[]> {
	const where = await shipAddresses(db, orderId);
	const accounts: AccountReads = new Map();
	const quoted = await Promise.all(
		boxes.map((b) =>
			outside.getRates({
				...where,
				parcel: b,
				insureAmount: b.insureAmount,
				signature,
				hazmat: b.hazmat,
			}),
		),
	);
	return Promise.all(
		quoted.map(async ({ rates }, i) => {
			const [rate] = rates
				.filter(
					(r) => r.carrier === choice.carrier && r.service === choice.service,
				)
				.sort((a, b) => a.cost - b.cost);
			if (!rate) {
				throw new Error(
					`${choice.carrier} no longer offers that service${boxes.length > 1 ? ` for box ${i + 1}` : ""}; price again`,
				);
			}
			// Boxes on one account share its read (see getRate).
			const confirmed = await outside.getRate(rate.id, accounts);
			if (
				confirmed.carrier !== choice.carrier ||
				confirmed.service !== choice.service
			) {
				throw new Error("The quoted service changed; price again");
			}
			return confirmed;
		}),
	);
}

// Refunds the boxes of a purchase that stopped part way, recording each
// refund as it's granted. A refund the provider refuses leaves that box
// live, to be voided from the order page.
async function refundAll(db: Db, boxes: Shipment[], outside: BuyOutside) {
	const after: Shipment[] = [];
	for (const box of boxes) {
		try {
			const { status } = await outside.refund(box.externalId);
			const [voided] = await db
				.update(shipments)
				.set({ voidedAt: new Date(), refundStatus: status })
				.where(eq(shipments.id, box.id))
				.returning();
			after.push(voided);
		} catch {
			after.push(box);
		}
	}
	return after;
}
