import { toast } from "sonner";
import type { DismissTarget } from "#/diagnostics/dismissals";
import { optimism } from "#/lib/optimism";
import {
	type Diagnostics,
	dismissProblem,
	restoreProblem,
} from "#/server/diagnostics";
import { diagnosticsData } from "./diagnostics-data";
import type { ChannelData } from "./status";

// Problems: one list of everything that needs someone, each row with what
// can be done about it.

export type Problem =
	| { kind: "sync"; channel: ChannelData }
	| { kind: "handoff"; row: Diagnostics["handoffs"][number] }
	| { kind: "storefront"; row: Diagnostics["storefrontTracking"][number] }
	| { kind: "charges"; row: Diagnostics["charges"][number] }
	| {
			kind: "issue";
			channel: ChannelData["channel"];
			group: ChannelData["issues"][number];
	  };

export const GROUPS = {
	sync: "Sync",
	tracking: "Tracking",
	fees: "Fees",
	orders: "Orders",
} as const;
export type Group = keyof typeof GROUPS;
export type Filter = Group | "all" | "dismissed";

export function groupOf(p: Problem): Group {
	switch (p.kind) {
		case "sync":
			return "sync";
		case "handoff":
		case "storefront":
			return "tracking";
		case "charges":
			return "fees";
		case "issue":
			return "orders";
	}
}

export function isDismissed(p: Problem) {
	switch (p.kind) {
		case "sync":
			return false;
		case "issue":
			return p.group.dismissed;
		default:
			return p.row.dismissed;
	}
}

// Sync failing goes away only when a pass works, so it can't be dismissed.
export function targetOf(p: Problem): DismissTarget | null {
	switch (p.kind) {
		case "sync":
			return null;
		case "handoff":
			return {
				kind: "handoff",
				dispatchId: p.row.dispatchId,
				orderId: p.row.orderId,
			};
		case "storefront":
			return { kind: "storefront", shipmentId: p.row.shipmentId };
		case "charges":
			return {
				kind: "charges",
				billedBy: p.row.billedBy,
				error: p.row.error,
			};
		case "issue":
			return { kind: "issue", channel: p.channel, message: p.group.message };
	}
}

export function problemsOf(d: Diagnostics): Problem[] {
	return [
		...d.channels
			.filter(
				(c) =>
					c.health === "failing" || (d.worker.alive && c.health === "stale"),
			)
			.map((channel) => ({ kind: "sync" as const, channel })),
		...d.handoffs.map((row) => ({ kind: "handoff" as const, row })),
		...d.storefrontTracking.map((row) => ({
			kind: "storefront" as const,
			row,
		})),
		...d.charges.map((row) => ({ kind: "charges" as const, row })),
		...d.channels.flatMap((c) =>
			c.issues
				.filter((group) => !group.unmatched)
				.map((group) => ({
					kind: "issue" as const,
					channel: c.channel,
					group,
				})),
		),
	];
}

export function problemKey(p: Problem) {
	switch (p.kind) {
		case "sync":
			return `sync:${p.channel.channel}`;
		case "handoff":
			return `handoff:${p.row.dispatchId}:${p.row.orderId}`;
		case "storefront":
			return `storefront:${p.row.shipmentId}`;
		case "charges":
			return `charges:${p.row.billedBy}:${p.row.error}`;
		case "issue":
			return `issue:${p.channel}:${p.group.message}`;
	}
}

// Marks what a target covers on the page, until the reload shows it.
function setDismissed(
	d: Diagnostics,
	t: DismissTarget,
	dismissed: boolean,
): Diagnostics {
	switch (t.kind) {
		case "handoff":
			return {
				...d,
				handoffs: d.handoffs.map((r) =>
					r.dispatchId === t.dispatchId && r.orderId === t.orderId
						? { ...r, dismissed }
						: r,
				),
			};
		case "storefront":
			return {
				...d,
				storefrontTracking: d.storefrontTracking.map((r) =>
					r.shipmentId === t.shipmentId ? { ...r, dismissed } : r,
				),
			};
		case "charges":
			return {
				...d,
				charges: merge(
					d.charges.map((r) =>
						r.billedBy === t.billedBy && r.error === t.error
							? { ...r, dismissed }
							: r,
					),
					(r) => `${r.billedBy} ${r.error} ${r.dismissed}`,
					(a, b) => ({
						...a,
						orders: a.orders + b.orders,
						lastAt: a.lastAt > b.lastAt ? a.lastAt : b.lastAt,
					}),
				),
			};
		case "issue":
			return {
				...d,
				channels: d.channels.map((c) =>
					c.channel === t.channel
						? {
								...c,
								issues: merge(
									c.issues.map((g) =>
										g.message === t.message ? { ...g, dismissed } : g,
									),
									(g) => `${g.message} ${g.dismissed}`,
									(a, b) => ({
										...a,
										count: a.count + b.count,
										references: [...a.references, ...b.references],
									}),
								),
							}
						: c,
				),
			};
	}
}

// A group split into dismissed and not becomes one again once it's all
// dismissed (or all restored).
function merge<T>(rows: T[], id: (row: T) => string, add: (a: T, b: T) => T) {
	const byId = new Map<string, T>();
	for (const row of rows) {
		const seen = byId.get(id(row));
		byId.set(id(row), seen ? add(seen, row) : row);
	}
	return [...byId.values()];
}

export function setDismissedNow(target: DismissTarget, dismissed: boolean) {
	return optimism.change({
		label: dismissed ? "Dismissing" : "Restoring",
		patch: diagnosticsData.patch("all", (d) =>
			setDismissed(d, target, dismissed),
		),
		send: (): Promise<unknown> =>
			dismissed
				? dismissProblem({ data: { target } })
				: restoreProblem({ data: { target } }),
	});
}

export async function dismissNow(target: DismissTarget) {
	const r = await setDismissedNow(target, true);
	if (!r) return;
	toast("Dismissed", {
		action: { label: "Undo", onClick: () => setDismissedNow(target, false) },
	});
}
