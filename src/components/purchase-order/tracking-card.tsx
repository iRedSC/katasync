import { Copy, ExternalLink, Plus, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	CARRIER,
	carrierPage,
	PackageStatus,
} from "#/components/package-status";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { lacksHistory } from "#/purchasing/tracking-history";
import {
	addPoTracking,
	fillPoTrackingHistory,
	type PurchaseOrderDetail,
	removePoTracking,
} from "#/server/purchasing";
import { poData } from "./po-data";

type Tracking = PurchaseOrderDetail["tracking"][number];

// Packages coming for a sent PO: found in the supplier's emails or added
// here, followed on Shippo every four hours. A delivery here receives nothing.
export function TrackingCard({ detail: d }: { detail: PurchaseOrderDetail }) {
	const po = d.order;
	const [adding, setAdding] = useState(false);
	const [sending, setSending] = useState(false);
	const [failed, setFailed] = useState(false);

	// Packages without their scans yet get them now rather than at the next
	// sweep; the page reloads with them when Shippo has answered.
	const missing = d.tracking.some((t) => lacksHistory(t));
	useEffect(() => {
		if (!missing) return;
		optimism.change({
			send: () => fillPoTrackingHistory({ data: { purchaseOrderId: po.id } }),
		});
	}, [missing, po.id]);

	if (po.status !== "sent" && po.status !== "closed") return null;
	if (d.tracking.length === 0 && po.status === "closed") return null;

	async function add(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = e.currentTarget;
		const number = String(new FormData(form).get("number")).trim();
		if (!number) return;
		setSending(true);
		const r = await optimism.change({
			label: "Adding tracking",
			patch: [],
			send: () => addPoTracking({ data: { purchaseOrderId: po.id, number } }),
		});
		setSending(false);
		setFailed(!r);
		if (r) {
			form.reset();
			setAdding(false);
		}
	}

	async function remove(t: Tracking) {
		const r = await optimism.change({
			label: "Removing tracking",
			patch: poData.patch(po.id, (data) => ({
				...data,
				tracking: data.tracking.filter((x) => x.id !== t.id),
			})),
			send: () => removePoTracking({ data: { id: t.id } }),
		});
		if (!r) return;
		offerUndo(`Stopped following ${t.number}`, {
			undo: async () => {
				const back = await optimism.change({
					label: "Following it again",
					patch: [],
					send: () =>
						addPoTracking({
							data: {
								purchaseOrderId: po.id,
								number: t.number,
								carrier: t.carrier as keyof typeof CARRIER,
							},
						}),
				});
				return back ? `Following ${t.number} again` : null;
			},
		});
	}

	return (
		<Card
			title="Tracking"
			aside={
				!adding && (
					<button
						type="button"
						onClick={() => setAdding(true)}
						className="text-link hover:underline"
					>
						Add
					</button>
				)
			}
		>
			<ul className="flex flex-col gap-3">
				{d.tracking.map((t) => {
					return (
						<ContextMenu key={t.id}>
							<ContextMenuTrigger asChild>
								<li>
									<a
										href={carrierPage(t)}
										target="_blank"
										rel="noreferrer"
										className="block truncate font-mono text-xs text-link hover:underline"
									>
										{CARRIER[t.carrier as keyof typeof CARRIER] ?? t.carrier}{" "}
										{t.number}
									</a>
									<PackageStatus t={t} />
								</li>
							</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuItem
									onSelect={() => window.open(carrierPage(t), "_blank")}
								>
									<ExternalLink />
									Open on{" "}
									{CARRIER[t.carrier as keyof typeof CARRIER] ?? t.carrier}
								</ContextMenuItem>
								<ContextMenuItem
									onSelect={() =>
										navigator.clipboard
											.writeText(t.number)
											.then(() => toast.success("Copied"))
									}
								>
									<Copy />
									Copy number
								</ContextMenuItem>
								<ContextMenuSeparator />
								<ContextMenuItem
									onSelect={() => remove(t)}
									className="text-critical-text [&_svg]:text-critical-text"
								>
									<X />
									Stop following
								</ContextMenuItem>
							</ContextMenuContent>
						</ContextMenu>
					);
				})}
			</ul>
			{adding && (
				<form onSubmit={add} className="mt-2 flex gap-1.5">
					<input
						name="number"
						// biome-ignore lint/a11y/noAutofocus: opened by clicking Add
						autoFocus
						placeholder="Tracking number"
						disabled={sending}
						onChange={() => setFailed(false)}
						onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
						className={cn(
							"h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs",
							failed && "border-critical-border ring-2 ring-critical-border/40",
						)}
					/>
					<Button size="sm" type="submit" disabled={sending}>
						<Plus />
					</Button>
				</form>
			)}
		</Card>
	);
}
