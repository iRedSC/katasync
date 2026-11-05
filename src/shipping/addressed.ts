import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import { dispatches, labelAttempts, type SentTo, shipments } from "#/db/schema";
import { shipFrom } from "./addresses";
import { LabelRefused, outcomeOf } from "./label-attempt-state";
import { recordBought, settleWithout } from "./label-attempts";
import { overShown } from "./price-check";
import {
	type Address,
	buyLabel,
	findLabel,
	getRate,
	getRates,
	type Parcel,
	refundLabel,
	shippoIsTest,
} from "./shippo";

// A package sent to an address for no order: one box, a Shippo label, and a
// record of who it went to. Nothing order-side happens (see dispatches in
// schema.ts).

// Every addressed dispatch shares this key, which no order's contents can
// spell, so quick ship never suggests their boxes for an order.
export const ADDRESSED_KEY = "addressed";

export type AddressedOutside = {
	getRates: typeof getRates;
	getRate: typeof getRate;
	buyLabel: typeof buyLabel;
	findLabel: typeof findLabel;
	refund: typeof refundLabel;
	isTest: () => boolean;
};

export const liveAddressed: AddressedOutside = {
	getRates,
	getRate,
	buyLabel,
	findLabel,
	refund: refundLabel,
	isTest: shippoIsTest,
};

export type AddressedBox = Parcel & { packageId: number | null };

const toAddress = (to: SentTo): Address => ({ ...to, country: "US" });

// Every Shippo service for this box to this address, cheapest first.
export async function addressedRates(
	db: Db,
	input: { to: SentTo; box: AddressedBox },
	outside: AddressedOutside = liveAddressed,
) {
	const { rates, notes } = await outside.getRates({
		from: await shipFrom(db),
		to: toAddress(input.to),
		parcel: input.box,
		insureAmount: null,
		signature: false,
		hazmat: false,
	});
	return {
		rates: [...rates].sort((a, b) => a.cost - b.cost),
		notes,
		test: outside.isTest(),
	};
}

export type AddressedBought =
	| {
			kind: "bought";
			dispatchId: number;
			shipmentId: number;
			sentTo: SentTo;
			trackingNumber: string | null;
			serviceName: string;
			cost: number;
			test: boolean;
	  }
	// No clear answer from Shippo, so it may have been charged. Sending the
	// same attemptId again asks Shippo what happened instead of buying.
	| { kind: "unsure"; message: string };

const UNSURE =
	"No clear answer from Shippo, so it may have been bought. Press the service again to check; it won't buy twice.";

// Buys the label for the service chosen, priced again here so a stale quote
// from the browser can't be bought, and only at no more than the total that
// was shown. attemptId is the browser's name for this purchase, kept until
// it hears a clear answer: sent again (after a lost response, say), it
// settles the purchase already made instead of buying another. The purchase
// is saved before Shippo is asked (label-attempts.ts), so a lost answer is
// never mistaken for nothing bought.
export async function buyAddressed(
	db: Db,
	input: {
		attemptId: string;
		to: SentTo;
		box: AddressedBox;
		choice: { carrier: string; service: string; total: number };
	},
	outside: AddressedOutside = liveAddressed,
): Promise<AddressedBought> {
	const [earlier] = await db
		.select()
		.from(labelAttempts)
		.where(eq(labelAttempts.id, input.attemptId));
	if (earlier) return settleEarlier(db, earlier, outside);

	const { to, box, choice } = input;
	const { rates } = await outside.getRates({
		from: await shipFrom(db),
		to: toAddress(to),
		parcel: box,
		insureAmount: null,
		signature: false,
		hazmat: false,
	});
	const [quoted] = rates
		.filter((r) => r.carrier === choice.carrier && r.service === choice.service)
		.sort((a, b) => a.cost - b.cost);
	if (!quoted) {
		throw new Error(
			`${choice.carrier} no longer offers that service; price again`,
		);
	}
	const rate = await outside.getRate(quoted.id);
	if (rate.carrier !== choice.carrier || rate.service !== choice.service) {
		throw new Error("The quoted service changed; price again");
	}
	const rose = overShown([rate.cost], choice.total);
	if (rose) throw new Error(rose);

	// Together, so a second request with the same attemptId leaves nothing.
	const attempt = await db.transaction(async (tx) => {
		const [dispatch] = await tx
			.insert(dispatches)
			.values({
				contentsKey: ADDRESSED_KEY,
				contents: "addressed",
				boxCount: 1,
				sentTo: to,
				setsDefault: false,
			})
			.returning({ id: dispatches.id });
		const [made] = await tx
			.insert(labelAttempts)
			.values({
				id: input.attemptId,
				dispatchId: dispatch.id,
				boxIndex: 0,
				provider: "shippo",
				rateId: rate.id,
				unitIds: null,
				state: "pending",
				box: {
					dispatchId: dispatch.id,
					packageId: box.packageId,
					lengthMm: box.lengthMm,
					widthMm: box.widthMm,
					heightMm: box.heightMm,
					weightGrams: box.weightGrams,
					hazmat: false,
					provider: "shippo",
					carrier: rate.carrier,
					carrierToken: rate.carrierToken,
					service: rate.service,
					serviceName: rate.serviceName,
					cost: rate.cost,
					insuredAmount: null,
					signature: false,
					test: outside.isTest(),
				},
			})
			.returning();
		return made;
	});
	let label: Awaited<ReturnType<typeof buyLabel>>;
	try {
		label = await outside.buyLabel(rate.id, attempt.id);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		if (outcomeOf(err) === "unknown") {
			await settleWithout(db, attempt, "unknown", { error: why }).catch(
				() => {},
			);
			return { kind: "unsure", message: UNSURE };
		}
		await settleWithout(db, attempt, "failed", { error: why });
		throw err;
	}
	try {
		const { shipment } = await recordBought(db, attempt, {
			externalId: label.id,
			trackingNumber: label.trackingNumber,
			trackingUrl: label.trackingUrl,
			labelUrl: label.labelUrl,
			voided: null,
		});
		return boughtOf(db, shipment.id);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		const refunded = await outside
			.refund(label.id)
			.then(() => true)
			.catch(() => false);
		if (refunded) {
			await settleWithout(db, attempt, "failed", {
				error: `Bought but not saved (${why}); refunded`,
			}).catch(() => {});
			throw new LabelRefused(
				`A label was bought but couldn't be saved (${why}); it was refunded`,
			);
		}
		// Still pending: pressing again finds it on Shippo and records it.
		throw new Error(
			`A label was bought but couldn't be saved (${why}); press the service again to record it`,
		);
	}
}

// A purchase this attemptId already made: what it came to, asking Shippo
// when katasync never heard.
async function settleEarlier(
	db: Db,
	attempt: typeof labelAttempts.$inferSelect,
	outside: AddressedOutside,
): Promise<AddressedBought> {
	if (attempt.state === "succeeded" && attempt.shipmentId) {
		return boughtOf(db, attempt.shipmentId);
	}
	if (attempt.state === "failed") {
		throw new LabelRefused(
			`Not bought (${attempt.error}); nothing was charged. Price again.`,
		);
	}
	const found = await outside.findLabel(attempt.rateId, attempt.id);
	switch (found.kind) {
		case "bought": {
			const { shipment } = await recordBought(db, attempt, found.label);
			return boughtOf(db, shipment.id);
		}
		case "refused":
			await settleWithout(db, attempt, "failed", { error: found.why });
			throw new LabelRefused(
				`Not bought (${found.why}); nothing was charged. Price again.`,
			);
		case "pending":
		case "none":
			await settleWithout(db, attempt, "unknown", {
				error: attempt.error ?? "No answer from Shippo",
				lastLookup: found.kind,
			});
			return { kind: "unsure", message: UNSURE };
	}
}

async function boughtOf(db: Db, shipmentId: number): Promise<AddressedBought> {
	const [row] = await db
		.select({
			dispatchId: shipments.dispatchId,
			sentTo: dispatches.sentTo,
			trackingNumber: shipments.trackingNumber,
			serviceName: shipments.serviceName,
			cost: shipments.cost,
			test: shipments.test,
		})
		.from(shipments)
		.innerJoin(dispatches, eq(dispatches.id, shipments.dispatchId))
		.where(eq(shipments.id, shipmentId));
	if (!row?.sentTo) throw new Error(`No package label ${shipmentId}`);
	return { kind: "bought", shipmentId, ...row, sentTo: row.sentTo };
}

// Asks Shippo for an addressed package's postage back. Only addressed
// dispatches: an order's label is voided from its order page, which also
// takes the tracking back off the marketplace. The label is claimed first,
// so two voids at once can't both ask for the refund; a refused refund
// gives it back.
export async function voidAddressed(
	db: Db,
	dispatchId: number,
	outside: AddressedOutside = liveAddressed,
) {
	const [box] = await db
		.update(shipments)
		.set({ voidedAt: new Date(), refundStatus: "REQUESTED" })
		.where(
			and(
				eq(shipments.dispatchId, dispatchId),
				isNull(shipments.voidedAt),
				inArray(
					shipments.dispatchId,
					db
						.select({ id: dispatches.id })
						.from(dispatches)
						.where(eq(dispatches.contents, "addressed")),
				),
			),
		)
		.returning({ id: shipments.id, externalId: shipments.externalId });
	if (!box) throw new Error("This label is already voided");
	let status: string;
	try {
		({ status } = await outside.refund(box.externalId));
	} catch (err) {
		await db
			.update(shipments)
			.set({ voidedAt: null, refundStatus: null })
			.where(eq(shipments.id, box.id));
		throw err;
	}
	await db
		.update(shipments)
		.set({ refundStatus: status })
		.where(eq(shipments.id, box.id));
	return { refundStatus: status };
}

// Packages sent so far, newest first: who to, which label, and whether it
// was voided. Only labels actually bought; a purchase still unsure has none.
export async function sentPackages(db: Db, limit = 100) {
	const rows = await db
		.select({
			dispatchId: dispatches.id,
			shipmentId: shipments.id,
			sentTo: dispatches.sentTo,
			serviceName: shipments.serviceName,
			cost: shipments.cost,
			trackingNumber: shipments.trackingNumber,
			trackingUrl: shipments.trackingUrl,
			test: shipments.test,
			voidedAt: shipments.voidedAt,
			refundStatus: shipments.refundStatus,
			createdAt: shipments.createdAt,
		})
		.from(shipments)
		.innerJoin(dispatches, eq(dispatches.id, shipments.dispatchId))
		.where(eq(dispatches.contents, "addressed"))
		.orderBy(desc(shipments.createdAt), desc(shipments.id))
		.limit(limit);
	return rows.flatMap((r) => (r.sentTo ? [{ ...r, sentTo: r.sentTo }] : []));
}
