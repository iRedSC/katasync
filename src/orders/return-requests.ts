import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderLines,
	orders,
	returnRequestLines,
	returnRequests,
} from "#/db/schema";
import { errorText } from "#/diagnostics/runs";
import {
	type EvidenceRead,
	NO_EVIDENCE,
	type ReturnEvidence,
	underAToZ,
	withRead,
} from "./return-evidence";
import { type ReturnRecord, saveRecords } from "./return-records";

// Returns buyers opened on a marketplace, as each channel's importer reads
// them (amazon-returns.ts, shopify-returns.ts, ebay-returns.ts), saved one
// way so the Returns pages and order_line_returns read them alike.

export type ReturnStatus = (typeof returnRequests.$inferInsert)["status"];
// A refund with nothing coming back never ships (return_requests_refund_never_ships).
export type RefundStatus = Extract<
	ReturnStatus,
	"requested" | "processing" | "unknown" | "closed" | "cancelled"
>;
// What was asked for, and where it stands.
export type Ownership =
	| { waitingOn: "us"; respondBy: Date | null }
	| { waitingOn: "buyer" | "marketplace"; respondBy: null };
export type ObligationStage<Status extends string> = (
	| ({ status: Exclude<Status, "closed" | "cancelled"> } & Ownership)
	| { status: "closed" | "cancelled"; waitingOn: "nobody"; respondBy: null }
) & { escalation: (typeof returnRequests.$inferSelect)["escalation"] };
export type RequestStage = (
	| { kind: "return"; status: ReturnStatus }
	| { kind: "refund"; status: RefundStatus }
) &
	ObligationStage<ReturnStatus>;

export type CaseMoney =
	| { amount: string; currency: string }
	| { amount: null; currency: null };

// Wave 2 fills other marketplaces' deadlines from their own APIs.
export function returnStage(
	status: ReturnStatus,
	waitingOn: "us" | "buyer" | "marketplace",
): RequestStage & { kind: "return" } {
	if (status === "closed" || status === "cancelled")
		return {
			kind: "return",
			status,
			waitingOn: "nobody",
			respondBy: null,
			escalation: null,
		};
	return {
		kind: "return",
		status,
		waitingOn,
		respondBy: null,
		escalation: null,
	};
}

export type ChannelReturn = RequestStage &
	// Money left out is money the read couldn't see: what's saved stays.
	(CaseMoney | { amount?: undefined; currency?: undefined }) & {
		nextAction: string | null;
		caseRef: string | null;
		problems?: string[];
		// The marketplace's id for the return, unique per channel.
		externalId: string;
		// The order's id there, as orders.externalId stores it.
		orderExternalId: string;
		// Where it really sold, when another marketplace relayed it (a TikTok
		// order Shopify passed on: "tiktok:<id>"). Such an order may since have
		// moved to that marketplace's store, so it's found by this instead.
		marketplaceOrderId?: string | null;
		// The marketplace's own wording.
		rawStatus: string;
		// Why, as the marketplace names it (a code or its words).
		reason: string | null;
		// What the buyer wrote, when they wrote anything. Left out when it wasn't
		// asked for or couldn't be read: a note already saved stays as it is.
		note?: string | null;
		// Its history with the buyer's evidence, when it was read (TikTok's
		// records). Left out keeps what's saved.
		records?: ReturnRecord[];
		recordsUnread?: boolean;
		trackingNumber: string | null;
		carrier: string | null;
		requestedAt: Date;
		// The marketplace's version of it, when it gives one (isNews).
		updatedAt?: Date;
		// Left out by marketplaces whose reads don't say any of it.
		evidence?: EvidenceRead;
		lines: {
			// The line's id there, as order_lines.externalId stores it.
			lineExternalId: string | null;
			alternateLineExternalId?: string | null;
			sku: string | null;
			quantity: number;
			// The item's own, when the marketplace gives each item one.
			reason?: string | null;
			rawStatus?: string | null;
		}[];
	};

type Line = { id: number; externalId: string; sku: string | null };

// Which of the order's lines a returned item was: by the line's id, then
// its SKU, then the only line there is. None when it's still unclear.
export function matchLine(
	lines: Line[],
	item: ChannelReturn["lines"][number],
): number | null {
	const byId = item.lineExternalId
		? lines.find((l) => l.externalId === item.lineExternalId)
		: undefined;
	if (byId) return byId.id;
	const byAlternateId = item.alternateLineExternalId
		? lines.find((line) => line.externalId === item.alternateLineExternalId)
		: undefined;
	if (byAlternateId) return byAlternateId.id;
	const bySku = item.sku ? lines.filter((l) => l.sku === item.sku) : [];
	if (bySku.length === 1) return bySku[0].id;
	return lines.length === 1 ? lines[0].id : null;
}

// What a return saves as, with its lines matched to ours. A fresh read that
// makes the same snapshot as the saved one needs no write. Lines compare as a
// set, since their order means nothing; a line that has since matched a
// different order line changes its orderLineId, so the snapshot changes too.
type SavedLine = {
	orderLineId: number | null;
	sku: string | null;
	quantity: number;
	reason: string | null;
	rawStatus: string | null;
};
type Snapshot = RequestStage &
	ReturnEvidence & {
		amount: string | null;
		currency: string | null;
		nextAction: string | null;
		caseRef: string | null;
		orderId: number;
		rawStatus: string;
		reason: string | null;
		note: string | null;
		recordsUnread: boolean;
		trackingNumber: string | null;
		carrier: string | null;
		requestedAt: Date;
		// Null when the marketplace never said and nothing is saved yet.
		sourceUpdatedAt: Date | null;
		lines: SavedLine[];
	};

// As read back from the database, where kind and status are two columns.
type Saved = Omit<Snapshot, keyof RequestStage> & {
	kind: RequestStage["kind"];
	status: ReturnStatus;
	waitingOn: RequestStage["waitingOn"];
	respondBy: Date | null;
	escalation: RequestStage["escalation"];
};

function canonical(s: Saved) {
	return JSON.stringify([
		s.orderId,
		s.kind,
		s.status,
		s.waitingOn,
		s.respondBy?.getTime() ?? null,
		s.escalation,
		s.nextAction,
		s.caseRef,
		s.amount,
		s.currency,
		s.rawStatus,
		s.reason,
		s.note,
		s.recordsUnread,
		s.trackingNumber,
		s.carrier,
		s.requestedAt.getTime(),
		s.sourceUpdatedAt?.getTime() ?? null,
		s.aToZClaim,
		// Field by field: jsonb reads back with its keys in its own order.
		s.safetClaim && [
			s.safetClaim.id,
			s.safetClaim.state,
			s.safetClaim.reason,
			s.safetClaim.reimbursement?.amount ?? null,
			s.safetClaim.reimbursement?.currency ?? null,
			s.safetClaim.createdAt,
		],
		s.resolution,
		s.inPolicy,
		s.returnType,
		s.label && [
			s.label.type,
			s.label.cost?.amount ?? null,
			s.label.cost?.currency ?? null,
			s.label.paidBy,
		],
		s.deliveredAt?.getTime() ?? null,
		s.lines
			.map((l) =>
				JSON.stringify([
					l.orderLineId,
					l.sku,
					l.quantity,
					l.reason,
					l.rawStatus,
				]),
			)
			.sort(),
	]);
}

// Whether a read is news over what's saved. One with the marketplace's
// version (updatedAt) is, unless what's saved has a newer one; equal counts,
// since reads of a channel take turns and a later one is at least as fresh.
// One without a version never replaces one with.
export function isNews(
	saved: { sourceVersioned: boolean; sourceUpdatedAt: Date },
	updatedAt: Date | undefined,
) {
	if (!saved.sourceVersioned) return true;
	return updatedAt !== undefined && saved.sourceUpdatedAt <= updatedAt;
}

// isNews, on the saved row itself.
const newsGuard = (updatedAt: Date | undefined) =>
	updatedAt
		? sql`(not ${returnRequests.sourceVersioned} or ${returnRequests.sourceUpdatedAt} <= ${updatedAt.toISOString()}::timestamptz)`
		: sql`not ${returnRequests.sourceVersioned}`;

// Saves each return against its order in this store, replacing what the
// marketplace said before. A return for an order katasync doesn't have
// (older than its history, or never synced) is skipped, and its order named
// in missing and handed back in unsaved, so the pass can hold its place. A
// return that hasn't changed since it was saved is left alone, and one the
// marketplace says changed before what's saved (a late or repeated read) is
// older news and changes nothing.
export async function saveReturns(
	db: Db,
	store: { id: number; channel: ChannelReturnChannel },
	returns: ChannelReturn[],
): Promise<{
	saved: number;
	skipped: number;
	missing: string[];
	unsaved: ChannelReturn[];
}> {
	if (returns.length === 0)
		return { saved: 0, skipped: 0, missing: [], unsaved: [] };
	const known = await db
		.select({ id: orders.id, externalId: orders.externalId })
		.from(orders)
		.where(
			and(
				eq(orders.storeId, store.id),
				inArray(orders.externalId, [
					...new Set(returns.map((r) => r.orderExternalId)),
				]),
			),
		);
	const orderIds = new Map(known.map((o) => [o.externalId, o.id]));
	const relayed = returns.flatMap((r) => r.marketplaceOrderId ?? []);
	const moved =
		relayed.length > 0
			? await db
					.select({ id: orders.id, key: orders.marketplaceOrderId })
					.from(orders)
					.where(inArray(orders.marketplaceOrderId, [...new Set(relayed)]))
			: [];
	const movedIds = new Map(moved.map((o) => [o.key, o.id]));
	// Each return with its order here; no orderId when katasync doesn't have it.
	const placed = returns.map((r) => ({
		r,
		orderId:
			orderIds.get(r.orderExternalId) ??
			(r.marketplaceOrderId ? movedIds.get(r.marketplaceOrderId) : undefined),
	}));
	// Read once for the whole batch rather than once per return: the order
	// lines to match against, and what's saved already.
	const placedIds = [...new Set(placed.flatMap((p) => p.orderId ?? []))];
	const lineRows =
		placedIds.length > 0
			? await db
					.select({
						id: orderLines.id,
						orderId: orderLines.orderId,
						externalId: orderLines.externalId,
						sku: orderLines.sku,
					})
					.from(orderLines)
					.where(inArray(orderLines.orderId, placedIds))
			: [];
	const linesOf = new Map<number, Line[]>();
	for (const l of lineRows) {
		const bucket = linesOf.get(l.orderId);
		if (bucket) bucket.push(l);
		else linesOf.set(l.orderId, [l]);
	}
	const requests = await db
		.select({
			id: returnRequests.id,
			externalId: returnRequests.externalId,
			orderId: returnRequests.orderId,
			kind: returnRequests.kind,
			status: returnRequests.status,
			waitingOn: returnRequests.waitingOn,
			respondBy: returnRequests.respondBy,
			escalation: returnRequests.escalation,
			nextAction: returnRequests.nextAction,
			caseRef: returnRequests.caseRef,
			amount: returnRequests.amount,
			currency: returnRequests.currency,
			rawStatus: returnRequests.rawStatus,
			reason: returnRequests.reason,
			note: returnRequests.note,
			recordsUnread: returnRequests.recordsUnread,
			trackingNumber: returnRequests.trackingNumber,
			carrier: returnRequests.carrier,
			requestedAt: returnRequests.requestedAt,
			sourceUpdatedAt: returnRequests.sourceUpdatedAt,
			sourceVersioned: returnRequests.sourceVersioned,
			aToZClaim: returnRequests.aToZClaim,
			safetClaim: returnRequests.safetClaim,
			resolution: returnRequests.resolution,
			inPolicy: returnRequests.inPolicy,
			returnType: returnRequests.returnType,
			label: returnRequests.label,
			deliveredAt: returnRequests.deliveredAt,
		})
		.from(returnRequests)
		.where(
			and(
				eq(returnRequests.billedBy, store.channel),
				inArray(returnRequests.externalId, [
					...new Set(returns.map((r) => r.externalId)),
				]),
			),
		);
	const requestLines =
		requests.length > 0
			? await db
					.select({
						requestId: returnRequestLines.requestId,
						orderLineId: returnRequestLines.orderLineId,
						sku: returnRequestLines.sku,
						quantity: returnRequestLines.quantity,
						reason: returnRequestLines.reason,
						rawStatus: returnRequestLines.rawStatus,
					})
					.from(returnRequestLines)
					.where(
						inArray(
							returnRequestLines.requestId,
							requests.map((q) => q.id),
						),
					)
			: [];
	const linesOfRequest = new Map<number, SavedLine[]>();
	for (const l of requestLines) {
		const line = {
			orderLineId: l.orderLineId,
			sku: l.sku,
			quantity: l.quantity,
			reason: l.reason,
			rawStatus: l.rawStatus,
		};
		const bucket = linesOfRequest.get(l.requestId);
		if (bucket) bucket.push(line);
		else linesOfRequest.set(l.requestId, [line]);
	}
	const savedBy = new Map(
		requests.map((q) => [
			q.externalId,
			{ ...q, lines: linesOfRequest.get(q.id) ?? [] },
		]),
	);
	let saved = 0;
	const missing = new Set<string>();
	const unsaved: ChannelReturn[] = [];
	for (const { r, orderId } of placed) {
		if (orderId === undefined) {
			unsaved.push(r);
			// A Shopify gid reads as its number.
			missing.add(r.orderExternalId.split("/").pop() ?? r.orderExternalId);
			continue;
		}
		const current = savedBy.get(r.externalId);
		if (current && !isNews(current, r.updatedAt)) {
			saved++;
			continue;
		}
		const lines = linesOf.get(orderId) ?? [];
		const evidence = withRead(current ?? NO_EVIDENCE, r.evidence ?? {});
		const money: CaseMoney =
			r.amount !== undefined ? r : savedMoney(current ?? null);
		const next: Snapshot = {
			orderId,
			// A claim saved before keeps it escalated through a read that
			// couldn't see the claim.
			...(evidence.aToZClaim ? underAToZ(r) : r),
			...evidence,
			...money,
			nextAction: r.nextAction,
			caseRef: r.caseRef,
			rawStatus: r.rawStatus,
			reason: r.reason,
			// A note the marketplace didn't send keeps the one saved.
			note: r.note === undefined ? (current?.note ?? null) : r.note,
			recordsUnread: r.recordsUnread ?? current?.recordsUnread ?? false,
			trackingNumber: r.trackingNumber,
			carrier: r.carrier,
			requestedAt: r.requestedAt,
			sourceUpdatedAt: r.updatedAt ?? current?.sourceUpdatedAt ?? null,
			lines: r.lines.map((l) => ({
				orderLineId: matchLine(lines, l),
				sku: l.sku,
				quantity: l.quantity,
				reason: l.reason ?? null,
				rawStatus: l.rawStatus ?? null,
			})),
		};
		if (current && canonical(current) === canonical(next)) {
			const records = r.records;
			// Checked again on the row itself, locked, as the upsert below is:
			// newer news may have been saved since this read looked.
			if (records)
				await db.transaction(async (tx) => {
					const [still] = await tx
						.update(returnRequests)
						.set({ syncedAt: sql`now()` })
						.where(
							and(eq(returnRequests.id, current.id), newsGuard(r.updatedAt)),
						)
						.returning({ id: returnRequests.id });
					if (still) await saveRecords(tx, current.id, records);
				});
			saved++;
			continue;
		}
		await db.transaction(async (tx) => {
			const values = {
				orderId,
				billedBy: store.channel,
				externalId: r.externalId,
				kind: next.kind,
				status: next.status,
				waitingOn: next.waitingOn,
				respondBy: next.respondBy,
				escalation: next.escalation,
				nextAction: next.nextAction,
				caseRef: next.caseRef,
				amount: next.amount,
				currency: next.currency,
				rawStatus: next.rawStatus,
				reason: next.reason,
				note: next.note,
				recordsUnread: next.recordsUnread,
				noteUnread: next.recordsUnread,
				trackingNumber: next.trackingNumber,
				carrier: next.carrier,
				requestedAt: next.requestedAt,
				aToZClaim: next.aToZClaim,
				safetClaim: next.safetClaim,
				resolution: next.resolution,
				inPolicy: next.inPolicy,
				returnType: next.returnType,
				label: next.label,
				deliveredAt: next.deliveredAt,
				// Without the marketplace's time, when it changed here.
				sourceUpdatedAt: r.updatedAt ?? new Date(),
				sourceVersioned: r.updatedAt !== undefined,
			};
			const [request] = await tx
				.insert(returnRequests)
				.values(values)
				.onConflictDoUpdate({
					target: [returnRequests.billedBy, returnRequests.externalId],
					set: { ...values, syncedAt: sql`now()` },
					// An older snapshot (a page read before the case closed) would
					// reopen it, so it changes nothing. Decided on the row the upsert
					// locks, so it holds when two snapshots of a new case cross.
					setWhere: newsGuard(r.updatedAt),
				})
				.returning({ id: returnRequests.id });
			if (!request) return;
			await tx
				.delete(returnRequestLines)
				.where(eq(returnRequestLines.requestId, request.id));
			if (next.lines.length > 0)
				await tx
					.insert(returnRequestLines)
					.values(next.lines.map((l) => ({ requestId: request.id, ...l })));
			if (r.records) await saveRecords(tx, request.id, r.records);
		});
		saved++;
	}
	return {
		saved,
		skipped: returns.length - saved,
		missing: [...missing],
		unsaved,
	};
}

// What a return had saved as its money, as a pair.
function savedMoney(
	saved: { amount: string | null; currency: string | null } | null,
): CaseMoney {
	return saved?.amount != null && saved.currency != null
		? { amount: saved.amount, currency: saved.currency }
		: { amount: null, currency: null };
}

type ChannelReturnChannel = (typeof returnRequests.$inferInsert)["billedBy"];

// A record a read found but couldn't save, at the marketplace time its
// search found it by: the pass keeps a gap open there (feed_gaps) until a
// read of it saves.
export type Held = { at: Date; detail: string };

// What a channel's returns read hands back. held: records it found but
// couldn't save whole (a Shopify return too big for one read).
export type FoundReturns =
	| ChannelReturn[]
	| { returns: ChannelReturn[]; problems: string[]; held?: Held[] };

export type ReturnsRead =
	| { kind: "read"; problems: string[]; held: Held[] }
	| { kind: "failed"; error: string }
	| { kind: "pending" };

// One read of a channel's returns, saved. Returns come from their own API,
// often with a permission of its own; when that fails it's the returns feed
// that failed, not the channel. A return for an order katasync doesn't have
// is held: its box would turn up unexpected, and nothing past it is
// verified until it saves. Null from fetch means nothing to read yet (a
// report still being built).
export async function importReturns(
	db: Db,
	store: { id: number; channel: ChannelReturnChannel; name: string },
	fetch: () => Promise<FoundReturns | null>,
): Promise<ReturnsRead> {
	try {
		const found = await fetch();
		if (!found) return { kind: "pending" };
		const { returns, problems, held } = Array.isArray(found)
			? { returns: found, problems: [], held: [] }
			: { ...found, held: found.held ?? [] };
		problems.push(...returns.flatMap((r) => r.problems ?? []));
		const { unsaved } = await saveReturns(db, store, returns);
		return {
			kind: "read",
			problems,
			held: [
				...held,
				...unsaved.map((r) => ({
					at: r.updatedAt ?? r.requestedAt,
					detail: `${store.name} return for order ${r.orderExternalId.split("/").pop()}, which katasync doesn't have`,
				})),
			],
		};
	} catch (error) {
		return { kind: "failed", error: errorText(error) };
	}
}
