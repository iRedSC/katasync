import type { Lookup } from "./label-attempt-state";
import { assertUnchanged, byKey, type PackedLine, unmappable } from "./packed";

// TikTok lists every unit sold as its own line item. These match a box's
// packed lines to them: by sku_id for an order katasync took from TikTok
// itself (its lines are keyed so), by seller SKU for one relayed through
// Shopify. A unit or line with nothing to match on holds the order.

export type TiktokUnit = {
	id: string;
	skuId: string | null;
	sellerSku: string | null;
	cancelled: boolean;
	packageId: string | null;
};

export type TiktokOrderUnits = {
	status: string;
	packages: string[];
	units: TiktokUnit[];
};

const unitKey = (relayed: boolean) => (u: TiktokUnit) =>
	relayed ? u.sellerSku : u.skuId;
const lineKey = (relayed: boolean) => (l: PackedLine) =>
	relayed ? l.sku : l.lineExternalId;

function assertUnitsMatch(
	live: TiktokUnit[],
	packed: PackedLine[],
	relayed: boolean,
) {
	const want = byKey(packed, lineKey(relayed));
	if (!want) {
		throw unmappable(
			"A packed item has no SKU to find on TikTok; fulfill it in TikTok Seller Center",
		);
	}
	const have = new Map<string, number>();
	for (const unit of live) {
		const key = unitKey(relayed)(unit);
		if (!key) {
			throw unmappable(
				"TikTok lists an item katasync can't match; fulfill it in TikTok Seller Center",
			);
		}
		have.set(key, (have.get(key) ?? 0) + 1);
	}
	const titles = new Map(
		packed.flatMap((l) => {
			const key = lineKey(relayed)(l);
			return key ? [[key, l.title] as const] : [];
		}),
	);
	assertUnchanged(want, have, titles);
}

// The units a new label is for: every one not cancelled, which must be
// exactly what was packed. Only an order TikTok still waits on can get one.
export function unitsToBuy(
	order: TiktokOrderUnits,
	packed: PackedLine[],
	relayed: boolean,
): string[] {
	if (order.status !== "AWAITING_SHIPMENT") {
		throw new Error(
			`TikTok order is ${order.status.toLowerCase().replaceAll("_", " ")}; no new label`,
		);
	}
	const live = order.units.filter((u) => !u.cancelled);
	assertUnitsMatch(live, packed, relayed);
	return live.map((u) => u.id);
}

// Before telling TikTok the package is ready: the units it was bought for
// are still exactly every unit not cancelled, and still what was packed.
export function assertShippable(
	order: TiktokOrderUnits,
	unitIds: string[],
	packed: PackedLine[],
	relayed: boolean,
) {
	const live = order.units.filter((u) => !u.cancelled);
	assertUnitsMatch(live, packed, relayed);
	const ids = new Set(unitIds);
	if (live.length !== ids.size || live.some((u) => !ids.has(u.id))) {
		throw unmappable(
			"TikTok's items changed since the label was bought; check the order in TikTok Seller Center",
		);
	}
}

// Whether TikTok made the package for an unanswered purchase: one package
// holding exactly the attempt's units and nothing else, on an order TikTok
// has moved on. Anything less certain stays unknown.
export function packageFor(order: TiktokOrderUnits, unitIds: string[]): Lookup {
	const ids = new Set(unitIds);
	const mine = order.units.filter((u) => ids.has(u.id));
	if (mine.length !== ids.size) return { kind: "pending" };
	const packages = new Set(mine.map((u) => u.packageId));
	const [only] = packages;
	if (packages.size !== 1) return { kind: "pending" };
	if (only === null) {
		return order.status === "AWAITING_SHIPMENT" && order.packages.length === 0
			? { kind: "none" }
			: { kind: "pending" };
	}
	const covers = order.units.filter((u) => u.packageId === only);
	if (
		order.status === "AWAITING_SHIPMENT" ||
		!order.packages.includes(only) ||
		covers.length !== ids.size
	) {
		return { kind: "pending" };
	}
	return {
		kind: "bought",
		label: {
			externalId: only,
			trackingNumber: null,
			trackingUrl: null,
			labelUrl: null,
			voided: null,
		},
	};
}
