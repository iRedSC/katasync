import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import type { Tone } from "#/components/page";
import { Button } from "#/components/ui/button";
import type { CheckTarget } from "#/diagnostics/checks";
import { channelName, formatCount } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { resendTracking, retryStorefront } from "#/server/shipping";
import type { Problem } from "./problems";
import { ago } from "./status";

export function describe(
	p: Problem,
	open: (target: CheckTarget) => void,
): {
	tone: Tone;
	title: ReactNode;
	detail: string;
	at: string | null;
	action: ReactNode;
} {
	switch (p.kind) {
		case "sync": {
			const c = p.channel;
			const name = channelName(c.channel);
			const details = (
				<Button size="sm" variant="outline" onClick={() => open(c.channel)}>
					Details
				</Button>
			);
			return c.health === "failing"
				? {
						tone: "critical",
						title: `${name} sync failing`,
						detail: c.latestError ?? "",
						at: `since ${ago(c.failingSince)}`,
						action: details,
					}
				: {
						tone: "warning",
						title: `${name} not syncing`,
						detail: `Last good sync ${ago(c.lastSuccessAt)}`,
						at: null,
						action: details,
					};
		}
		case "handoff": {
			// Still inside its ten minutes of retrying on its own.
			const retrying = p.row.retryAt !== null;
			return {
				tone: retrying ? "warning" : "critical",
				title: (
					<>
						<OrderLink id={p.row.orderId} name={p.row.orderName} /> tracking{" "}
						{retrying ? "retrying to" : "not sent to"}{" "}
						{channelName(p.row.channel)}
					</>
				),
				detail: retrying
					? `${p.row.error ?? ""} (try ${p.row.attempts}; trying again on its own for up to 10 minutes)`
					: `${p.row.error ?? ""}${p.row.attempts > 0 ? ` (gave up after ${p.row.attempts} tries)` : ""}`,
				at: ago(p.row.createdAt),
				action: (
					<RetryButton
						send={() =>
							resendTracking({ data: { dispatchId: p.row.dispatchId } })
						}
					/>
				),
			};
		}
		case "storefront":
			return {
				tone: "warning",
				title: (
					<>
						<OrderLink id={p.row.orderId} name={p.row.orderName} /> storefront
						tracking not {p.row.voided ? "removed" : "saved"}
					</>
				),
				detail: p.row.error,
				at: ago(p.row.createdAt),
				action: (
					<RetryButton
						send={() => retryStorefront({ data: { id: p.row.shipmentId } })}
					/>
				),
			};
		case "charges":
			return {
				tone: "warning",
				title: `${channelName(p.row.billedBy)} fees unread on ${formatCount(p.row.orders)} ${p.row.orders === 1 ? "order" : "orders"}`,
				detail: p.row.error,
				at: ago(p.row.lastAt),
				action: null,
			};
		case "issue": {
			const g = p.group;
			const more = g.count - g.references.length;
			return {
				tone: "warning",
				title: `${channelName(p.channel)}: ${g.message}`,
				detail: `${formatCount(g.count)} ${g.count === 1 ? "order" : "orders"}${g.references.length > 0 ? `: ${g.references.join(", ")}${more > 0 ? `, +${formatCount(more)}` : ""}` : ""}`,
				at: null,
				action: null,
			};
		}
	}
}

function OrderLink({ id, name }: { id: number; name: string }) {
	return (
		<Link
			to="/orders/$id"
			params={{ id: String(id) }}
			className="hover:underline"
		>
			{name}
		</Link>
	);
}

// Sending is outside the app, so the button waits for the server and the
// reload.
function RetryButton({
	send,
}: {
	send: () => Promise<{ sent: boolean; message: string }>;
}) {
	const [busy, setBusy] = useState(false);
	async function retry() {
		setBusy(true);
		const r = await optimism.change({ send });
		setBusy(false);
		if (!r) return;
		if (r.value.sent) toast.success(r.value.message);
		else toast.error(r.value.message);
	}
	return (
		<Button size="sm" variant="outline" disabled={busy} onClick={retry}>
			{busy && <Loader2 className="animate-spin" />}
			Retry
		</Button>
	);
}
