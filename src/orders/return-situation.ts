import type { ReturnState, returnRequests } from "#/db/schema";
import type { AdminPage } from "./admin-urls";
import type { PackageAt } from "./return-tracking";

// What one order's return comes to on the Returns tab, from everything that
// says something about it: the marketplace's open requests, the carrier,
// what was checked in here, and the refunds its marketplace reported. Each
// answers one question: where the item is, whether the buyer got their
// money, and what happens next. Pure, so the tab works it out again after
// an optimistic change.

type Request = typeof returnRequests.$inferSelect;

export type SituationRequest = Pick<
	Request,
	"billedBy" | "status" | "waitingOn" | "amount" | "currency" | "deliveredAt"
> & {
	tracking: PackageAt | null;
	answerOn: AdminPage | null;
};

// How what came back was checked in. Counted: back before katasync counted
// stock, so nobody looked at it here.
export type BackOutcome =
	| "restocked"
	| "refurbished"
	| "written_off"
	| "counted";

export type SituationInput = {
	// From order_returns_due; null when nothing more is expected back.
	state: ReturnState | null;
	noReturnAt: Date | null;
	// Its open return requests only.
	requests: SituationRequest[];
	back: { quantity: number; at: Date; outcome: BackOutcome } | null;
	// What its marketplace's refunds add up to, in the store's currency.
	refunded: number;
};

export type Money = { amount: number; currency: string };

export type Item =
	| { kind: "asked" }
	| { kind: "coming"; tracking: PackageAt | null }
	// The carrier or marketplace says it reached us; nobody checked it in.
	| { kind: "arrived"; at: Date | null }
	| { kind: "refunded_not_back" }
	| { kind: "maybe" }
	| { kind: "back"; at: Date; outcome: BackOutcome }
	| { kind: "not_coming" }
	// Found by search, with nothing expected back.
	| { kind: "not_expected" };

export type Refund =
	| { kind: "refunded"; amount: Money }
	// The marketplace says what the buyer asked for; none of it is refunded.
	| { kind: "asked"; amount: Money }
	| { kind: "none" };

export type Next =
	| { kind: "check_in" }
	| { kind: "answer"; on: AdminPage | null }
	| { kind: "refund"; on: AdminPage | null }
	| { kind: "decide" }
	| { kind: "in_transit" }
	| { kind: "with_buyer" }
	// Done here, but the marketplace still shows its return open.
	| { kind: "close"; on: AdminPage | null }
	| { kind: "done" };

export type Situation = { item: Item; refund: Refund; next: Next };

// Amazon's report gives what it refunded; TikTok gives what the buyer asks.
const AMOUNT_REFUNDED: Partial<Record<Request["billedBy"], true>> = {
	amazon: true,
};

const STORE_CURRENCY = "USD";

function item(o: SituationInput): Item {
	const arrived = o.requests.find(
		(r) =>
			r.status === "delivered" ||
			r.deliveredAt !== null ||
			r.tracking?.status === "DELIVERED",
	);
	const here = (r: SituationRequest): Item => ({
		kind: "arrived",
		at:
			r.deliveredAt ??
			(r.tracking?.status === "DELIVERED" ? r.tracking.statusAt : null),
	});
	const coming: Item = {
		kind: "coming",
		tracking: o.requests.find((r) => r.tracking)?.tracking ?? null,
	};
	switch (o.state) {
		case "on_its_way":
		case "requested":
		case "refunded":
			if (arrived) return here(arrived);
			if (o.state === "on_its_way") return coming;
			return o.state === "requested"
				? { kind: "asked" }
				: { kind: "refunded_not_back" };
		case "maybe":
			return { kind: "maybe" };
		case null:
			if (o.back) return { kind: "back", ...o.back };
			if (o.noReturnAt) return { kind: "not_coming" };
			// Open on its marketplace though nothing's due here (its lines
			// never took stock): where the marketplace says it is.
			if (arrived) return here(arrived);
			if (o.requests.some((r) => r.status === "shipped" || r.tracking))
				return coming;
			return o.requests.length > 0
				? { kind: "asked" }
				: { kind: "not_expected" };
	}
}

function refund(o: SituationInput): Refund {
	if (o.refunded > 0)
		return {
			kind: "refunded",
			amount: { amount: o.refunded, currency: STORE_CURRENCY },
		};
	const sum = (rows: SituationRequest[]): Money | null => {
		// A zero says nothing was refunded (or asked).
		const priced = rows.filter(
			(r) => r.amount !== null && Number(r.amount) > 0 && r.currency,
		);
		if (priced.length === 0) return null;
		return {
			amount: priced.reduce((n, r) => n + Number(r.amount), 0),
			currency: priced[0].currency ?? STORE_CURRENCY,
		};
	};
	const said = sum(o.requests.filter((r) => AMOUNT_REFUNDED[r.billedBy]));
	if (said) return { kind: "refunded", amount: said };
	const asked = sum(o.requests.filter((r) => !AMOUNT_REFUNDED[r.billedBy]));
	return asked ? { kind: "asked", amount: asked } : { kind: "none" };
}

function next(o: SituationInput, it: Item, money: Refund): Next {
	const open = o.requests[0];
	const page = o.requests.find((r) => r.answerOn)?.answerOn ?? null;
	switch (it.kind) {
		case "arrived":
			return { kind: "check_in" };
		case "asked":
		case "coming": {
			const ours = o.requests.find(
				(r) => r.waitingOn === "us" && r.status !== "delivered",
			);
			if (ours) return { kind: "answer", on: ours.answerOn };
			return { kind: it.kind === "asked" ? "with_buyer" : "in_transit" };
		}
		case "refunded_not_back":
		case "maybe":
			return { kind: "decide" };
		case "back":
		case "not_coming":
			if (!open) return { kind: "done" };
			// Counted at cutover is a guess that it came back, not a check-in,
			// so it never asks for a refund.
			if (
				it.kind === "back" &&
				it.outcome !== "counted" &&
				money.kind !== "refunded"
			)
				return { kind: "refund", on: page };
			return { kind: "close", on: page };
		case "not_expected":
			return { kind: "done" };
	}
}

export function returnSituation(o: SituationInput): Situation {
	const it = item(o);
	const money = refund(o);
	return { item: it, refund: money, next: next(o, it, money) };
}

// The tab's groups, most urgent first. Close is last and folded: the
// marketplace closes most of them on its own.
export const NEXT_ORDER: Next["kind"][] = [
	"check_in",
	"answer",
	"refund",
	"decide",
	"in_transit",
	"with_buyer",
	"close",
	"done",
];

// Whether the next step is ours, for the tab's count.
export const ours = (n: Next) =>
	n.kind === "check_in" ||
	n.kind === "answer" ||
	n.kind === "refund" ||
	n.kind === "decide";
