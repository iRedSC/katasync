import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatMoney } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { printLabels } from "#/printing/qz-client";
import type { OrderDetail } from "#/server/orders";
import { resendTracking, voidLabel } from "#/server/shipping";
import { HoldNote, holdBadge, UnsureLabel } from "./unsure-label";

export function SendRow({
	send: d,
	channel,
}: {
	send: OrderDetail["sends"][number];
	channel: string;
}) {
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	const live = d.boxes.filter((b) => b.voidedAt === null);
	const first = d.boxes[0];
	const test = d.boxes.some((b) => b.test);

	// Talks to a carrier or marketplace, so it waits for the reload that shows
	// it. A failure is toasted by the engine; a success is said once it's shown.
	async function act(work: () => Promise<string>) {
		setBusy(true);
		const r = await optimism.change({ send: work });
		setBusy(false);
		setConfirm(false);
		if (r) toast.success(r.value);
	}

	// Sending tracking needs every box bought and none voided.
	const sendable = d.complete && live.length === d.boxes.length;
	const unsure = d.attempts.length > 0;
	const hold = d.hold;
	const state = unsure
		? { tone: "warning" as const, text: "Purchase unconfirmed" }
		: !d.live
			? {
					tone: undefined,
					text: `Voided · refund ${(first?.refundStatus ?? "requested").toLowerCase()}`,
				}
			: !sendable
				? { tone: "critical" as const, text: "Incomplete, void it" }
				: test
					? { tone: "info" as const, text: "Test label" }
					: d.channelSentAt
						? { tone: "success" as const, text: `Tracking sent to ${channel}` }
						: hold
							? { tone: "critical" as const, text: holdBadge(hold) }
							: d.channelError
								? d.retrying
									? { tone: "warning" as const, text: "Tracking retrying" }
									: { tone: "critical" as const, text: "Tracking not sent" }
								: { tone: "warning" as const, text: "Tracking pending" };

	return (
		<li className="flex flex-col gap-2 border-t px-4 py-3 first:border-t-0">
			<div className="flex items-start justify-between gap-2">
				<div className={d.live ? "" : "text-muted-foreground line-through"}>
					<p className="font-medium">
						{first?.serviceName ?? "Label purchase"}
						{d.boxes.length > 1 && ` · ${d.boxes.length} boxes`}
					</p>
					<p className="tabular-nums">
						{formatMoney(d.boxes.reduce((sum, b) => sum + b.cost, 0))}
					</p>
				</div>
				<Badge tone={state.tone}>{state.text}</Badge>
			</div>
			{d.shippedWith.length > 0 && (
				<p>
					Shipped together with{" "}
					{d.shippedWith.map((o, i) => (
						<span key={o.id}>
							{i > 0 && ", "}
							<Link
								to="/orders/$id"
								params={{ id: String(o.id) }}
								className="font-medium text-link hover:underline"
							>
								{o.name}
							</Link>
						</span>
					))}
				</p>
			)}
			<ul className="flex flex-col gap-1">
				{d.boxes.map((b, i) => (
					<li
						key={b.id}
						className={`flex items-center gap-2 text-xs ${b.voidedAt ? "text-muted-foreground line-through" : ""}`}
					>
						{d.boxes.length > 1 && <span>Box {i + 1}</span>}
						{b.trackingNumber && (
							<a
								href={b.trackingUrl ?? undefined}
								target="_blank"
								rel="noreferrer"
								className="font-mono text-link hover:underline"
							>
								{b.trackingNumber}
							</a>
						)}
						{!b.voidedAt && (
							<button
								type="button"
								onClick={() => printLabels([b.id])}
								className="text-link hover:underline"
							>
								Print
							</button>
						)}
						{b.storefrontTrackingError && (
							<p className="text-warning-text">{b.storefrontTrackingError}</p>
						)}
					</li>
				))}
			</ul>
			{unsure && (
				<ul className="flex flex-col gap-1">
					{d.attempts.map((a) => (
						<UnsureLabel
							key={a.id}
							attempt={a}
							many={d.attempts.length > 1 || d.boxes.length > 0}
						/>
					))}
				</ul>
			)}
			{hold && d.live && <HoldNote hold={hold} />}
			{d.channelError && !d.channelSentAt && d.live && !hold && (
				<p className="text-critical-text">{d.channelError}</p>
			)}
			{!d.live && !unsure && d.unfinishedVoid && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-critical-text">Voiding didn't finish.</span>
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() =>
							act(async () => {
								const r = await voidLabel({ data: { dispatchId: d.id } });
								return r.notes.join(" ") || "Voiding finished";
							})
						}
					>
						Finish voiding
					</Button>
				</div>
			)}
			{d.live && (
				<div className="flex flex-wrap gap-2">
					{sendable && !d.channelSentAt && !test && (
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() =>
								act(async () => {
									const r = await resendTracking({
										data: { dispatchId: d.id },
									});
									if (!r.sent) throw new Error(r.message);
									return r.message;
								})
							}
						>
							{hold ? "Check again" : "Send tracking"}
						</Button>
					)}
					{/* TikTok has no API to cancel its labels. */}
					{live.some((b) => b.provider === "tiktok") ? (
						<span className="self-center text-xs text-muted-foreground">
							Cancel in TikTok Seller Center
						</span>
					) : confirm ? (
						<Button
							size="sm"
							variant="destructive"
							disabled={busy}
							onClick={() =>
								act(async () => {
									const r = await voidLabel({ data: { dispatchId: d.id } });
									// Some refunds refused: say so as a failure; Void stays.
									if (r.remaining > 0) throw new Error(r.notes.join(" "));
									return [
										`Voided, refund ${r.refundStatus.toLowerCase()}.`,
										...r.notes,
									].join(" ");
								})
							}
						>
							Void and refund{" "}
							{formatMoney(live.reduce((sum, b) => sum + b.cost, 0))}
							{d.shippedWith.length > 0 && " for every order in the box"}?
						</Button>
					) : (
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => setConfirm(true)}
						>
							{live.length > 1 ? "Void all labels" : "Void"}
						</Button>
					)}
				</div>
			)}
		</li>
	);
}
