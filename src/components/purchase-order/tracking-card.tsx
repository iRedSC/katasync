import { Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatDate, formatDateTime } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import {
	addPoTracking,
	type PurchaseOrderDetail,
	removePoTracking,
} from "#/server/purchasing";
import { poData } from "./po-data";

type Tracking = PurchaseOrderDetail["tracking"][number];

const CARRIER = { ups: "UPS", usps: "USPS", fedex: "FedEx" } as const;

const carrierPage = (t: Tracking) =>
	t.carrier === "ups"
		? `https://www.ups.com/track?tracknum=${t.number}`
		: t.carrier === "usps"
			? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t.number}`
			: `https://www.fedex.com/fedextrack/?trknbr=${t.number}`;

const STATUS: Record<
	NonNullable<Tracking["status"]>,
	{ label: string; dot: string }
> = {
	PRE_TRANSIT: { label: "Label made", dot: "bg-muted-foreground" },
	TRANSIT: { label: "On its way", dot: "bg-info-icon" },
	DELIVERED: { label: "Delivered", dot: "bg-success-icon" },
	RETURNED: { label: "Returned", dot: "bg-critical-icon" },
	FAILURE: { label: "Problem", dot: "bg-critical-icon" },
	UNKNOWN: { label: "Not found yet", dot: "bg-warning-icon" },
};

// Packages coming for a sent PO: found in the supplier's emails or added
// here, followed on Shippo every four hours. A delivery here receives nothing.
export function TrackingCard({ detail: d }: { detail: PurchaseOrderDetail }) {
	const po = d.order;
	const [adding, setAdding] = useState(false);
	const [sending, setSending] = useState(false);
	const [failed, setFailed] = useState(false);
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
			<ul className="flex flex-col gap-2">
				{d.tracking.map((t) => {
					const s = t.status ? STATUS[t.status] : null;
					return (
						<li key={t.id} className="group flex items-start gap-2">
							<span
								className={cn(
									"mt-1.5 size-2 shrink-0 rounded-full",
									s?.dot ?? "animate-pulse bg-muted-foreground/40",
								)}
							/>
							<span className="min-w-0 flex-1">
								<a
									href={carrierPage(t)}
									target="_blank"
									rel="noreferrer"
									className="block truncate font-mono text-xs text-link hover:underline"
								>
									{CARRIER[t.carrier as keyof typeof CARRIER] ?? t.carrier}{" "}
									{t.number}
								</a>
								<Tip content={t.statusDetail}>
									<span className="block text-xs text-muted-foreground">
										{s ? s.label : "Asking Shippo"}
										{t.status === "DELIVERED" && t.statusAt
											? ` ${formatDateTime(t.statusAt)}`
											: t.eta
												? `, due ${formatDate(t.eta)}`
												: ""}
									</span>
								</Tip>
							</span>
							<Button
								size="icon"
								variant="ghost"
								className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
								aria-label={`Stop following ${t.number}`}
								onClick={() => remove(t)}
							>
								<X />
							</Button>
						</li>
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
