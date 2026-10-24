import { PackageCheck, Tag, TriangleAlert, Truck, Undo2 } from "lucide-react";
import { HoverCard } from "radix-ui";
import type { TrackingEvent } from "#/db/schema";
import { formatDate, formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";

// A package followed on Shippo, wherever katasync follows one: the stops it
// has reached, and on hover everything Shippo said about it. A null status
// is still being asked about.
type Tracking = {
	carrier: string;
	number: string;
	status: TrackingEvent["status"] | null;
	statusDetail: string | null;
	statusAt: Date | null;
	eta: Date | null;
	originalEta: Date | null;
	service: string | null;
	origin: string | null;
	destination: string | null;
	history: TrackingEvent[];
	checkedAt: Date | null;
};
export type { Tracking as FollowedPackage };

export const CARRIER = { ups: "UPS", usps: "USPS", fedex: "FedEx" } as const;

export const carrierPage = (t: Pick<Tracking, "carrier" | "number">) =>
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

// Its timeline and where it stands, with the whole story on hover.
export function PackageStatus({ t }: { t: Tracking }) {
	const s = t.status ? STATUS[t.status] : null;
	return (
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
									className={cn(slipped(t) && "font-medium text-warning-text")}
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
	);
}

// Where it stands in a few words, for a list of packages: red when it went
// wrong, green once it's there.
export function PackageWhere({
	t,
}: {
	t: Pick<Tracking, "statusAt" | "eta"> & {
		status: NonNullable<Tracking["status"]>;
	};
}) {
	const s = STATUS[t.status];
	return (
		<span
			className={cn(
				s.trouble
					? "text-critical-text"
					: s.reached === LAST
						? "text-success-text"
						: "text-muted-foreground",
			)}
		>
			{s.label}
			{t.status === "DELIVERED" && t.statusAt
				? ` ${formatDate(t.statusAt)}`
				: t.eta && !s.trouble
					? `, due ${formatDate(t.eta)}`
					: ""}
		</span>
	);
}
