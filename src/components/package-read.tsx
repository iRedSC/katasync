import { ExternalLink, LoaderCircle, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ago } from "#/components/diagnostics/status";
import { shake } from "#/components/shake";
import { Tip } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";
import type { TrackingRead } from "#/orders/tracking-read";

// The line above a package wherever its scans show: its number, linking to
// the carrier's own page, and how far what's shown can be trusted. Scans
// from before a failed refresh get an amber dot and their age; no scans at
// all for a failure gets a red one. Either can be asked again: a spinner,
// then the new scans, or a red flash and shake when it failed again.

// Red, then back, with a shake: asking again didn't work.
export function flashFailed(el: HTMLElement | null) {
	shake(el);
	el?.animate(
		[
			{ backgroundColor: "var(--critical-fill)" },
			{ backgroundColor: "transparent" },
		],
		{ duration: 900, easing: "ease-out" },
	);
}

// A read that can be asked for again, and what asking again came to. Null
// is a package not answered for yet; askNow asks as it first shows. Only a
// retry that was clicked flashes when it fails.
export function usePackageRead(
	initial: TrackingRead | null,
	again: (() => Promise<TrackingRead>) | null,
	askNow = false,
) {
	const [read, setRead] = useState(initial);
	const [asking, setAsking] = useState(askNow && again !== null);
	const row = useRef<HTMLDivElement>(null);
	// Only the latest ask lands, and none after the package is gone.
	const latest = useRef(0);
	useEffect(() => {
		setRead(initial);
		setAsking(false);
		return () => {
			latest.current++;
		};
	}, [initial]);
	const ask = async (clicked: boolean) => {
		if (!again) return;
		const mine = ++latest.current;
		setAsking(true);
		const now = await again().catch(() => null);
		if (mine !== latest.current) return;
		setAsking(false);
		if (now) setRead(now);
		if (clicked && now?.state !== "fresh") flashFailed(row.current);
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: the first ask, once per package shown
	useEffect(() => {
		if (askNow) ask(false);
	}, [askNow, initial]);
	return { read, asking, retry: again && (() => ask(true)), row };
}

export function PackageHead({
	label,
	page,
	read,
	asking,
	retry,
}: {
	label: string;
	// The carrier's tracking page; null when the carrier isn't known.
	page: string | null;
	read: TrackingRead | null;
	asking: boolean;
	retry: (() => void) | null;
}) {
	return (
		<div className="flex min-w-0 items-center gap-2 text-xs">
			{page ? (
				<a
					href={page}
					target="_blank"
					rel="noreferrer"
					className="inline-flex min-w-0 items-center gap-1 font-mono text-link hover:underline"
				>
					<span className="truncate">{label}</span>
					<ExternalLink className="size-3 shrink-0" />
				</a>
			) : (
				<span className="truncate font-mono">{label}</span>
			)}
			<span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
				{read && <ReadMark read={read} />}
				{asking ? (
					<LoaderCircle
						className="size-3.5 animate-spin"
						aria-label="Asking Shippo"
					/>
				) : (
					retry &&
					(read?.state === "stale" || read?.state === "failed") && (
						<button
							type="button"
							onClick={retry}
							aria-label="Ask again"
							className="grid size-5 place-items-center rounded-md hover:bg-surface hover:text-foreground"
						>
							<RotateCw className="size-3.5" />
						</button>
					)
				)}
			</span>
		</div>
	);
}

// Shippo's errors can carry a whole page.
const short = (why: string) =>
	why.length > 200 ? `${why.slice(0, 200)}…` : why;

const dot = "size-2 shrink-0 rounded-full";

// How much to trust what's shown, in a dot and as few words as fit.
export function ReadMark({ read }: { read: TrackingRead }) {
	switch (read.state) {
		case "fresh":
			return null;
		case "stale":
			return (
				<Tip content={`Couldn't refresh: ${short(read.why)}`}>
					<span className="flex items-center gap-1.5">
						<span className={cn(dot, "bg-warning-icon")} />
						as of {ago(read.t.checkedAt)}
					</span>
				</Tip>
			);
		case "failed":
			return (
				<Tip content={short(read.why)}>
					<span className="flex items-center gap-1.5 text-critical-text">
						<span className={cn(dot, "bg-critical-icon")} />
						No answer from Shippo
					</span>
				</Tip>
			);
		case "unsupported":
			return <span>Carrier not followed</span>;
		case "untracked":
			return <span>No tracking number</span>;
	}
}
