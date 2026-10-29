import { createFileRoute } from "@tanstack/react-router";
import { BadgeDollarSign } from "lucide-react";
import { Fragment, useMemo } from "react";
import { OrderTabs, ReturnsViews } from "#/components/order-tabs";
import { Card, EmptyState, Page } from "#/components/page";
import { type Choice, RefundRow } from "#/components/returns/refund-row";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { formatCount } from "#/lib/format";
import { optimism, optimistic, type Patch } from "#/lib/optimism";
import { useRowLink } from "#/lib/row-link";
import { offerUndo } from "#/lib/undo";
import type { RefundRow as Row } from "#/orders/refund-queue";
import {
	type Decision,
	type RefundStep,
	refundOurs,
	refundStep,
} from "#/orders/refund-step";
import {
	decideOrderRefund,
	getRefundQueue,
	type RefundQueueData,
	settleOrderRefund,
	undoOrderRefund,
} from "#/server/orders/refunds";

// What to do about each buyer's money once their return is checked in:
// refund it all or part, refuse, or flag something to do first. Refunds are
// made on the marketplace; each one waits here until its charges show it.

export const Route = createFileRoute("/orders/returns_/refunds")({
	loader: () => getRefundQueue(),
	component: Refunds,
	pendingComponent: () => (
		<ListSkeleton title="Orders" width="wide">
			<ListCard tabs />
		</ListSkeleton>
	),
});

const queue = optimistic<RefundQueueData>("refunds");

const decisionPatch = (orderId: number, decision: Decision | null): Patch =>
	queue.patch("all", (rows) =>
		rows.map((r) => (r.orderId === orderId ? { ...r, decision } : r)),
	);

const GROUPS: { kind: RefundStep["kind"]; heading: string; dot: string }[] = [
	{ kind: "decide", heading: "To decide", dot: "bg-amber-500" },
	{ kind: "flagged", heading: "Something else to do", dot: "bg-amber-500" },
	{ kind: "send", heading: "Waiting to see the refund", dot: "bg-sky-500" },
	{ kind: "done", heading: "Done lately", dot: "bg-emerald-500" },
];

const SAID: Record<Choice["decision"], string> = {
	full: "Full refund",
	partial: "Partial refund",
	none: "No refund",
	other: "Flagged",
};

function Refunds() {
	const loaded = Route.useLoaderData();
	const rows = queue.useData("all", loaded);
	const { link } = useRowLink();
	const steps = useMemo(
		() => new Map(rows.map((r) => [r.orderId, refundStep(r)])),
		[rows],
	);
	const stepOf = (r: Row) => steps.get(r.orderId) ?? refundStep(r);

	async function decide(r: Row, choice: Choice) {
		const guess: Decision = {
			id: 0,
			...choice,
			refundedBefore: r.refundedNow,
			decidedAt: new Date(),
			settledAt: null,
		};
		// The refund itself is made on the marketplace: its page opens with
		// the decision, unless there's nothing left to send.
		const next = refundStep({ ...r, decision: guess });
		if (r.page && (next.kind === "send" || choice.decision === "none"))
			window.open(r.page.url, "_blank", "noreferrer");
		const previous = r.decision;
		const done = await optimism.change({
			label: `${SAID[choice.decision]} on ${r.name}`,
			patch: decisionPatch(r.orderId, guess),
			send: () =>
				decideOrderRefund({
					data: {
						orderId: r.orderId,
						...choice,
						after: previous?.id ?? null,
					},
				}),
		});
		if (!done) return;
		offerUndo(`${SAID[choice.decision]} on ${r.name}`, {
			undo: async () => {
				const undone = await optimism.change({
					label: `Undoing on ${r.name}`,
					patch: decisionPatch(r.orderId, previous),
					send: () => undoOrderRefund({ data: { id: done.value.id } }),
				});
				return undone && `${r.name} is back to decide`;
			},
		});
	}

	async function settle(r: Row, settled: boolean) {
		const d = r.decision;
		if (!d || d.id === 0) return;
		const changed = await optimism.change({
			label: `${r.name}`,
			patch: decisionPatch(r.orderId, {
				...d,
				settledAt: settled ? new Date() : null,
			}),
			send: () => settleOrderRefund({ data: { id: d.id, settled } }),
		});
		if (!changed || !settled) return;
		offerUndo(
			d.decision === "other" ? `${r.name} resolved` : `${r.name} refunded`,
			{
				tone: "success",
				undo: async () => {
					const undone = await optimism.change({
						label: `Undoing on ${r.name}`,
						patch: decisionPatch(r.orderId, d),
						send: () =>
							settleOrderRefund({ data: { id: d.id, settled: false } }),
					});
					return undone && `${r.name} is open again`;
				},
			},
		);
	}

	// A settled decision is unsettled first; otherwise it comes off.
	async function undo(r: Row) {
		const d = r.decision;
		if (!d || d.id === 0) return;
		if (d.settledAt) return settle(r, false);
		// The decision before it, if any, shows again once the page reloads.
		await optimism.change({
			label: `Undoing on ${r.name}`,
			patch: decisionPatch(r.orderId, null),
			send: () => undoOrderRefund({ data: { id: d.id } }),
		});
	}

	const groups = GROUPS.map((g) => ({
		...g,
		rows: rows.filter((r) => stepOf(r).kind === g.kind),
	})).filter((g) => g.rows.length > 0);

	return (
		<Page title="Orders" width="wide">
			<Card flush className="overflow-visible">
				<OrderTabs
					active="returns"
					count={rows.filter((r) => refundOurs(stepOf(r))).length}
					aside={<ReturnsViews active="refunds" />}
				/>
				{groups.length === 0 ? (
					<EmptyState icon={BadgeDollarSign} title="No refunds to decide">
						Returns checked in on Triage come here.
					</EmptyState>
				) : (
					<table className="w-full">
						<thead>
							<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
								<th className="px-4 py-2 font-medium">Order</th>
								<th className="px-4 py-2 font-medium">What came back</th>
								<th className="hidden px-4 py-2 font-medium lg:table-cell">
									Buyer said
								</th>
								<th className="px-4 py-2 font-medium">Money</th>
								<th className="w-0 px-2 py-2" />
							</tr>
						</thead>
						<tbody>
							{groups.map((g) => (
								<Fragment key={g.kind}>
									<tr>
										<td
											colSpan={5}
											className="border-y bg-subtle px-4 py-1.5 text-xs font-medium text-muted-foreground"
										>
											<span className="flex items-center gap-2">
												<span className={`size-2 rounded-full ${g.dot}`} />
												{g.heading}
												<span className="tabular-nums">
													{formatCount(g.rows.length)}
												</span>
											</span>
										</td>
									</tr>
									{g.rows.map((r) => (
										<RefundRow
											key={r.orderId}
											row={r}
											step={stepOf(r)}
											onDecide={(c) => decide(r, c)}
											onSettle={() => settle(r, true)}
											onUndo={() => undo(r)}
											link={link}
										/>
									))}
								</Fragment>
							))}
						</tbody>
					</table>
				)}
			</Card>
		</Page>
	);
}
