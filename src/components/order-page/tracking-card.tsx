import { LoaderCircle, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BuyerOrder } from "#/buyers/order";
import {
	flashFailed,
	PackageHead,
	usePackageRead,
} from "#/components/package-read";
import { PackageDetails } from "#/components/package-status";
import { Card } from "#/components/page";
import { Bone } from "#/components/skeleton";
import { Tip } from "#/components/ui/tooltip";
import { channelName } from "#/lib/format";
import { cn } from "#/lib/utils";
import { knownOf } from "#/orders/tracking-read";
import { getOrderPackages, retryTracking } from "#/server/orders";

// Where each package is, scan by scan: katasync's labels and those bought
// on the channel's own site. Asked as the page opens; nothing shows for an
// order that hasn't gone out. When asking fails the card stays, saying so
// in a line, with the scans known from before.

type Package = BuyerOrder["packages"][number];
type Loaded = Awaited<ReturnType<typeof getOrderPackages>>;

type View =
	| { state: "asking" }
	| { state: "loaded"; data: Loaded }
	| { state: "failed"; why: string };

export function TrackingCard({ orderId }: { orderId: number }) {
	const [view, setView] = useState<View>({ state: "asking" });
	const [asking, setAsking] = useState(false);
	const trouble = useRef<HTMLParagraphElement>(null);
	const load = useCallback(
		async (isCurrent: () => boolean) => {
			setAsking(true);
			const next: View = await getOrderPackages({ data: { id: orderId } }).then(
				(data) => ({ state: "loaded", data }),
				(e: unknown) => ({
					state: "failed",
					why: e instanceof Error ? e.message : String(e),
				}),
			);
			if (!isCurrent()) return;
			setView(next);
			setAsking(false);
			return next;
		},
		[orderId],
	);
	useEffect(() => {
		let current = true;
		setView({ state: "asking" });
		load(() => current);
		return () => {
			current = false;
		};
	}, [load]);
	// Still failing: the line flashes, so the click visibly did something.
	const again = async () => {
		const next = await load(() => true);
		if (!next) return;
		if (next.state === "failed" || next.data.channel.state !== "read")
			flashFailed(trouble.current);
	};
	if (view.state === "asking")
		return (
			<Card title="Tracking">
				<Bone className="h-24" />
			</Card>
		);
	if (view.state === "failed")
		return (
			<Card title="Tracking">
				<Trouble
					ref={trouble}
					text="Couldn't load tracking"
					why={view.why}
					asking={asking}
					again={again}
				/>
			</Card>
		);
	const { packages, channel: read } = view.data;
	if (packages.length === 0 && read.state === "read") return null;
	return (
		<Card title="Tracking">
			<div className="flex flex-col gap-5 animate-in fade-in-0">
				{read.state !== "read" && (
					<Trouble
						ref={trouble}
						text={`Couldn't ask ${channelName(read.name)} for its packages${read.state === "stale" ? "; these are from before" : ""}`}
						why={read.why}
						asking={asking}
						again={again}
					/>
				)}
				{packages.map((p) => (
					<TrackedPackage key={p.key} p={p} />
				))}
			</div>
		</Card>
	);
}

// A whole lookup that failed, in one line, with a way to ask again.
function Trouble({
	ref,
	text,
	why,
	asking,
	again,
}: {
	ref: React.Ref<HTMLParagraphElement>;
	text: string;
	why: string;
	asking: boolean;
	again: () => void;
}) {
	return (
		<p
			ref={ref}
			className="-mx-2 flex items-center gap-2 rounded-lg px-2 text-xs text-critical-text"
		>
			<span className="size-2 shrink-0 rounded-full bg-critical-icon" />
			<Tip content={why}>
				<span>{text}</span>
			</Tip>
			<button
				type="button"
				onClick={again}
				disabled={asking}
				aria-label="Ask again"
				className="ml-auto grid size-5 place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
			>
				{asking ? (
					<LoaderCircle className="size-3.5 animate-spin" />
				) : (
					<RotateCw className="size-3.5" />
				)}
			</button>
		</p>
	);
}

function TrackedPackage({ p }: { p: Package }) {
	const carrier = p.followedAs;
	const number = p.number;
	const { read, asking, retry, row } = usePackageRead(
		p.tracking,
		carrier && number
			? () => retryTracking({ data: { carrier, number } })
			: null,
	);
	const t = knownOf(read);
	return (
		<div ref={row} className="-mx-2 flex flex-col gap-2 rounded-lg px-2">
			<PackageHead
				label={`${p.carrier} ${p.number ?? ""}`.trim()}
				page={p.url}
				read={read}
				asking={asking}
				retry={retry}
			/>
			{t && (
				<div className={cn(read?.state === "stale" && "opacity-80")}>
					<PackageDetails t={t} />
				</div>
			)}
		</div>
	);
}
