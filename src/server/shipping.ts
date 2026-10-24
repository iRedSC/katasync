import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "@vercel/functions";
import { type } from "arktype";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import { orders, packages, stores } from "#/db/schema";
import { labelSource } from "#/orders/fulfillment";
import { shipAddresses } from "#/shipping/addresses";
import { boxQuoter } from "#/shipping/box-quotes";
import { createBoxes, deleteBox, updateBox } from "#/shipping/boxes";
import { buyDispatch, MAX_BOXES } from "#/shipping/buy";
import {
	retryStorefrontTracking,
	sendTracking,
	voidDispatch,
} from "#/shipping/handoff";
import { checkLabelAttempt } from "#/shipping/label-attempts";
import { labelPdf } from "#/shipping/label-file";
import {
	combineRates,
	extraCosts,
	orderForShipping,
	rankRates,
	serviceHistory,
	shipmentPlan,
	signatureRequired,
} from "#/shipping/quick-ship";
import { followUpTracking, resendTrackingNow } from "#/shipping/retry";
import { type Rate, shippoIsTest } from "#/shipping/shippo";
import { tiktokOrderId, tiktokRates } from "#/shipping/tiktok";

export const listPackages = createServerFn({ method: "GET" }).handler(
	// Smallest first, so a filter that finds several lists them by size. The
	// product is numeric: three sides of a big box overflow an integer.
	async () =>
		getDb()
			.select()
			.from(packages)
			.orderBy(
				sql`${packages.lengthMm}::numeric * ${packages.widthMm} * ${packages.heightMm}`,
				asc(packages.id),
			),
);

const boxFields = {
	"name?": "string | null",
	lengthIn: "number > 0",
	widthIn: "number > 0",
	heightIn: "number > 0",
	weightOz: "number >= 0",
} as const;

export const savePackage = createServerFn({ method: "POST" })
	.validator(type(boxFields))
	.handler(async ({ data }) => (await createBoxes(getDb(), [data]))[0]);

export const updatePackage = createServerFn({ method: "POST" })
	.validator(
		type({
			...boxFields,
			id: "number.integer > 0",
		}),
	)
	.handler(async ({ data: { id, ...box } }) => updateBox(getDb(), id, box));

export const deletePackage = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => deleteBox(getDb(), data.id));

export const quickShipLookup = createServerFn({ method: "GET" })
	.validator(type({ pin: "1 <= number.integer <= 999" }))
	.handler(async ({ data }) => orderForShipping(getDb(), data.pin));

// What's in the box when these orders ship together (the pin's order
// first), for quick ship to show and price.
export const quickShipPlan = createServerFn({ method: "GET" })
	.validator(type({ orderIds: "(number.integer > 0)[] > 0" }))
	.handler(async ({ data }) => shipmentPlan(getDb(), data.orderIds));

const box = {
	packageId: "number.integer > 0 | null",
	lengthMm: "number.integer > 0",
	widthMm: "number.integer > 0",
	heightMm: "number.integer > 0",
	weightGrams: "number.integer > 0",
	insureAmount: "number > 0 | null",
	hazmat: "boolean",
} as const;

const send = {
	orderIds: "(number.integer > 0)[] > 0",
	contentsKey: "string",
	// Orders that need a signature get one either way (see buyDispatch).
	signature: "boolean",
} as const;

// Prices for every box, one line per service offered for all of them, most
// likely choice first. TikTok orders get TikTok's own services (one order,
// one box); everything else gets Shippo's carriers. The orders share one
// address (checked again when buying), so the first order's is used.
export const quickShipRates = createServerFn({ method: "POST" })
	.validator(type({ ...send, boxes: type(box).array().atLeastLength(1) }))
	.handler(async ({ data }) => {
		if (data.boxes.length > MAX_BOXES) {
			throw new Error(`At most ${MAX_BOXES} boxes in one shipment`);
		}
		const db = getDb();
		const [first] = await db
			.select({
				channel: stores.channel,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
				shipCountry: orders.shipCountry,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(eq(orders.id, data.orderIds[0]));
		if (!first) throw new Error(`No order ${data.orderIds[0]}`);
		let perBox: Awaited<ReturnType<typeof tiktokRates>>[];
		// The same quotes without insurance, and without a signature, when
		// those were asked for: what each adds is the difference.
		let noInsurance: Rate[] | null = null;
		let noSignature: Rate[] | null = null;
		let notes: string[] = [];
		let test = false;
		if (labelSource(first) === "tiktok") {
			if (data.boxes.length > 1) {
				throw new Error(
					"TikTok: one box per label. Split it in TikTok Seller Center.",
				);
			}
			// TikTok quotes one order at a time; a combined box is priced on the
			// pin's order at the whole box's size, as buying does.
			perBox = [
				await tiktokRates(
					tiktokOrderId(first.marketplaceOrderId),
					data.boxes[0],
				),
			];
		} else {
			const where = await shipAddresses(db, data.orderIds[0]);
			const members = await db
				.select({ channel: stores.channel, total: orders.total })
				.from(orders)
				.innerJoin(stores, eq(stores.id, orders.storeId))
				.where(inArray(orders.id, data.orderIds));
			const signature = data.signature || signatureRequired(members) !== null;
			const quote = boxQuoter(where);
			const quoteAll = (insure: boolean, sign: boolean) =>
				Promise.all(data.boxes.map((b) => quote(b, insure, sign)));
			// A comparison that fails leaves only its amounts off; the services
			// themselves still price.
			const combined = (insure: boolean, sign: boolean) =>
				quoteAll(insure, sign).then(
					(quotes) => combineRates(quotes.map((p) => p.rates)),
					() => null,
				);
			const insured = data.boxes.some((b) => b.insureAmount !== null);
			// The selected quotes come first in line, ahead of the comparisons.
			const [priced, bare, unsigned] = await Promise.all([
				quoteAll(true, signature),
				insured ? combined(false, signature) : null,
				signature ? combined(true, false) : null,
			]);
			noInsurance = bare;
			noSignature = unsigned;
			perBox = priced.map((p) => p.rates);
			notes = [...new Set(priced.flatMap((p) => p.notes))];
			test = shippoIsTest();
		}
		const history = await serviceHistory(
			db,
			data.contentsKey,
			data.boxes[0].packageId,
		);
		const rates = combineRates(perBox);
		const insuranceCosts = noInsurance && extraCosts(rates, noInsurance);
		const signatureCosts = noSignature && extraCosts(rates, noSignature);
		const key = (r: Rate) => `${r.carrier}|${r.service}`;
		return {
			rates: rankRates(rates, history).map((r) => ({
				...r,
				// What insurance and a signature add to this service, when chosen.
				insuranceCost: insuranceCosts?.get(key(r)) ?? null,
				signatureCost: signatureCosts?.get(key(r)) ?? null,
			})),
			notes,
			test,
		};
	});

// Buys one label per box with the chosen service, as one dispatch for every
// order in the box, then sends the tracking to each order's marketplace.
// See buyDispatch for what holds when part of it fails.
export const quickShipBuy = createServerFn({ method: "POST" })
	.validator(
		type({
			...send,
			boxes: type(box).array().atLeastLength(1),
			// Which service, not which rate: the server prices every box again,
			// and buys only if that comes to no more than total, the price shown.
			choice: {
				carrier: "string > 0",
				service: "string > 0",
				id: "string > 0",
				total: "number >= 0",
			},
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const bought = await buyDispatch(db, data);
		const handoff = bought.failed
			? null
			: await sendTracking(db, bought.dispatchId);
		if (handoff && !handoff.sent) keepRetrying(bought.dispatchId);
		// Saved now so reprints never depend on the provider. A failure here
		// is retried on the first print.
		for (const b of bought.boxes) {
			if (!b.voidedAt) await labelPdf(db, b.id).catch(() => {});
		}
		const live = bought.boxes.filter((b) => !b.voidedAt);
		return {
			dispatchId: bought.dispatchId,
			failed: bought.failed,
			unsure: bought.unsure,
			handoff,
			boxes: live.map((b) => ({
				id: b.id,
				trackingNumber: b.trackingNumber,
				cost: b.cost,
				hazmat: b.hazmat,
			})),
			serviceName: live[0]?.serviceName ?? null,
			provider: live[0]?.provider ?? null,
			test: live.some((b) => b.test),
			cost: live.reduce((sum, b) => sum + b.cost, 0),
		};
	});

// Tries sending a dispatch's tracking to its orders' marketplaces again,
// with a fresh ten minutes of retrying if it's refused.
export const resendTracking = createServerFn({ method: "POST" })
	.validator(type({ dispatchId: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const handoff = await resendTrackingNow(getDb(), data.dispatchId);
		if (!handoff.sent) keepRetrying(data.dispatchId);
		return handoff;
	});

// A refused send retries on its own after the response goes back (see
// followUpTracking). Does nothing if the refusal set no retry.
function keepRetrying(dispatchId: number) {
	waitUntil(
		followUpTracking(getDb(), dispatchId).catch((error) =>
			console.error(`Tracking follow-up for dispatch ${dispatchId}:`, error),
		),
	);
}

// Asks the provider what became of a label purchase that got no answer, and
// records what it finds (see checkLabelAttempt). A dispatch that's bought in
// full by it sends its tracking, as a purchase would have.
export const checkLabel = createServerFn({ method: "POST" })
	.validator(type({ attemptId: "string.uuid" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const { attempt, completed } = await checkLabelAttempt(db, data.attemptId);
		const handoff = completed
			? await sendTracking(db, attempt.dispatchId)
			: null;
		if (handoff && !handoff.sent) keepRetrying(attempt.dispatchId);
		return {
			state: attempt.state,
			lastLookup: attempt.lastLookup,
			error: attempt.error,
			handoff,
		};
	});

export const retryStorefront = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => retryStorefrontTracking(getDb(), data.id));

// Voids every box of a dispatch.
export const voidLabel = createServerFn({ method: "POST" })
	.validator(type({ dispatchId: "number.integer > 0" }))
	.handler(async ({ data }) => voidDispatch(getDb(), data.dispatchId));
