import {
	Copy,
	ExternalLink,
	PackageCheck,
	Plus,
	Tag,
	TriangleAlert,
	Truck,
	Undo2,
	X,
} from "lucide-react";
import { HoverCard } from "radix-ui";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { formatDate, formatDateTime } from "#/lib/format";
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

const CARRIER = { ups: "UPS", usps: "USPS", fedex: "FedEx" } as const;

const carrierPage = (t: Tracking) =>
	t.carrier === "ups"
		? `https://www.ups.com/track?tracknum=${t.number}`
		: t.carrier === "usps"
			? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t.number}`
			: `https://www.fedex.com/fedextrack/?trknbr=${t.number}`;

// The stops on a package's timeline.
const STOPS = [
	{ label: "Label made", icon: Tag },
	{ label: "On its way", icon: Truck },
	{ label: "Delivered", icon: PackageCheck },
] as const;
const LAST = STOPS.length - 1;

// What Shippo says, and how far along the timeline that is: the last stop
// reached, or -1 for none. Returned and failed packages stop on the way, in
// red.
const STATUS: Record<
	NonNullable<Tracking["status"]>,
	{ label: string; reached: number; trouble?: true }
> = {
	PRE_TRANSIT: { label: "Label made", reached: 0 },
	TRANSIT: { label: "On its way", reached: 1 },
	DELIVERED: { label: "Delivered", reached: 2 },
	RETURNED: { label: "Returned", reached: 1, trouble: true },
	FAILURE: { label: "Problem", reached: 1, trouble: true },
	UNKNOWN: { label: "Not found yet", reached: -1 },
};

// The badge colors: blue on the way, green delivered, red when it went
// wrong. Lines are the tone's border, a little stronger than its fill.
const TONES = {
	moving: {
		soft: "bg-info-fill",
		icon: "text-info-text",
		line: "bg-info-border",
		ring: "ring-info-border",
	},
	arrived: {
		soft: "bg-success-fill",
		icon: "text-success-text",
		line: "bg-success-border",
		ring: "ring-success-border",
	},
	trouble: {
		soft: "bg-critical-fill",
		icon: "text-critical-text",
		line: "bg-critical-border",
		ring: "ring-critical-border",
	},
} as const;

function toneOf(status: Tracking["status"]) {
	const s = status ? STATUS[status] : null;
	return s?.trouble
		? TONES.trouble
		: s?.reached === LAST
			? TONES.arrived
			: TONES.moving;
}

// Stops joined by lines, filled as far as the package has got. While it's
// moving, the line to the next stop fills halfway as it appears.
function Timeline({ status }: { status: Tracking["status"] }) {
	const s = status ? STATUS[status] : null;
	const reached = s?.reached ?? -1;
	const tone = toneOf(status);
	const moving = s !== null && !s.trouble && reached >= 0 && reached < LAST;
	return (
		<div className="my-2 flex items-center" aria-hidden>
			{STOPS.map(({ label, icon: Icon }, i) => (
				<div key={label} className={cn("flex items-center", i > 0 && "flex-1")}>
					{i > 0 && (
						<span
							className={cn(
								"relative mx-1 h-1 flex-1 rounded-full",
								i <= reached ? tone.line : "bg-muted",
							)}
						>
							{moving && i === reached + 1 && (
								<span
									className={cn(
										"absolute inset-y-0 left-0 w-1/2 rounded-full motion-safe:animate-half-fill",
										tone.line,
									)}
								/>
							)}
						</span>
					)}
					<span
						className={cn(
							"grid size-6 shrink-0 place-items-center rounded-full transition-colors",
							i <= reached
								? [tone.soft, tone.icon]
								: "bg-muted text-muted-foreground/40",
							i === reached && reached < LAST && ["ring-2", tone.ring],
							status === null && "animate-pulse",
						)}
					>
						{s?.trouble && i === reached ? (
							status === "RETURNED" ? (
								<Undo2 className="size-3.5" />
							) : (
								<TriangleAlert className="size-3.5" />
							)
						) : (
							<Icon className="size-3.5" />
						)}
					</span>
				</div>
			))}
		</div>
	);
}

// Everything Shippo told us about one package, for its hover card: where
// it stands, the service and route, when it's due (and the day first
// promised, if that slipped), and every scan, newest first.
function Details({ t }: { t: Tracking }) {
	const s = t.status ? STATUS[t.status] : null;
	const tone = toneOf(t.status);
	const route = [t.origin, t.destination].filter(Boolean).join(" → ");
	const carrier = CARRIER[t.carrier as keyof typeof CARRIER] ?? t.carrier;
	const scans = [...t.history].reverse();
	const Icon = s?.trouble
		? t.status === "RETURNED"
			? Undo2
			: TriangleAlert
		: (STOPS[Math.max(s?.reached ?? 0, 0)]?.icon ?? Tag);
	const when =
		t.status === "DELIVERED" && t.statusAt
			? formatDateTime(t.statusAt)
			: t.eta
				? `Due ${formatDate(t.eta)}`
				: null;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<p className="text-base leading-snug font-semibold">
						{s ? s.label : "Asking Shippo"}
					</p>
					<p className="text-xs text-muted-foreground">
						{[[carrier, t.service].filter(Boolean).join(" "), route]
							.filter(Boolean)
							.join(" · ")}
					</p>
				</div>
				<span
					className={cn(
						"grid size-9 shrink-0 place-items-center rounded-full",
						tone.soft,
						tone.icon,
					)}
				>
					<Icon className="size-4.5" />
				</span>
			</div>
			{(when || (s?.trouble && t.statusDetail)) && (
				<div className={cn("rounded-lg px-3 py-2", tone.soft, tone.icon)}>
					<p className="font-semibold">
						{s?.trouble ? (t.statusDetail ?? when) : when}
					</p>
					{slipped(t) && t.originalEta && t.status !== "DELIVERED" && (
						<p className="text-xs opacity-80">
							First promised {formatDate(t.originalEta)}
						</p>
					)}
				</div>
			)}
			{scans.length > 0 ? (
				<ol className="-mr-2 max-h-64 overflow-y-auto pr-2">
					{scans.map((e, i) => (
						<li
							key={`${e.at}-${e.status}-${e.detail}`}
							className="relative flex gap-3 pb-3 last:pb-0"
						>
							{/* The line down to the scan before this one. */}
							{i < scans.length - 1 && (
								<span className="absolute top-3 bottom-0 left-[0.3125rem] w-px bg-border" />
							)}
							<span
								className={cn(
									"relative mt-1 size-2.5 shrink-0 rounded-full",
									i === 0
										? cn(toneOf(e.status).line, "ring-4", toneOf(e.status).ring)
										: "border-2 border-muted-foreground/30 bg-popover",
								)}
							/>
							<div className="min-w-0 flex-1">
								<p
									className={cn(
										"leading-snug",
										i === 0 ? "font-medium" : "text-foreground/80",
									)}
								>
									{e.detail ?? STATUS[e.status].label}
								</p>
								<p className="text-xs text-muted-foreground">
									{[e.place, e.at && formatDateTime(e.at)]
										.filter(Boolean)
										.join(" · ")}
								</p>
							</div>
						</li>
					))}
				</ol>
			) : (
				!s?.trouble &&
				t.statusDetail && (
					<p className="text-muted-foreground">{t.statusDetail}</p>
				)
			)}
			<p className="flex justify-between gap-3 border-t pt-2 text-xs text-muted-foreground">
				<span className="font-mono">{t.number}</span>
				{t.checkedAt && <span>Checked {formatDateTime(t.checkedAt)}</span>}
			</p>
		</div>
	);
}

// The carrier now expects it on a later day than it first said.
const slipped = (t: Tracking) =>
	t.eta !== null &&
	t.originalEta !== null &&
	formatDate(t.eta) !== formatDate(t.originalEta) &&
	new Date(t.eta) > new Date(t.originalEta);

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
					const s = t.status ? STATUS[t.status] : null;
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
									<HoverCard.Root openDelay={150} closeDelay={100}>
										<HoverCard.Trigger asChild>
											<div>
												<Timeline status={t.status} />
												<span
													className={cn(
														"block text-xs text-muted-foreground",
														s?.trouble && "text-critical-text",
													)}
												>
													{s ? s.label : "Asking Shippo"}
													{t.status === "DELIVERED" && t.statusAt ? (
														` ${formatDateTime(t.statusAt)}`
													) : t.eta ? (
														<>
															, due{" "}
															{/* Later than first promised: the hover card has
														    the date it was. */}
															<span
																className={cn(
																	slipped(t) && "font-medium text-warning-text",
																)}
															>
																{formatDate(t.eta)}
															</span>
														</>
													) : null}
												</span>
											</div>
										</HoverCard.Trigger>
										<HoverCard.Portal>
											<HoverCard.Content
												side="left"
												align="start"
												sideOffset={12}
												collisionPadding={12}
												className="z-50 w-80 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-black/10"
											>
												<Details t={t} />
											</HoverCard.Content>
										</HoverCard.Portal>
									</HoverCard.Root>
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
