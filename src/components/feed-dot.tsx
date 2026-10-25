import { ago } from "#/components/diagnostics/status";
import type { Tone } from "#/components/page";
import { DOT } from "#/components/panel";
import type { Feed, FeedStatus } from "#/diagnostics/feed-health";
import { cn } from "#/lib/utils";

// One feed's health as a dot, for the Diagnostics grid and the Returns tab.
// The color says how it stands; a failing one pulses until it reads again.

export const FEED_NAMES: Record<Feed, string> = {
	orders: "Orders",
	returns: "Returns",
	messages: "Messages",
	charges: "Charges",
	tracking: "Tracking",
};

export function feedTone(s: FeedStatus): Tone | "neutral" | null {
	switch (s.state) {
		case "ok":
			return "success";
		case "partial":
		case "stale":
			return "warning";
		case "failed":
			return "critical";
		case "pending":
			return "info";
		case "never":
		case "not_connected":
			return "neutral";
		case "unsupported":
			return null;
	}
}

// When it last read everything, short.
export function feedWhen(s: FeedStatus): string {
	switch (s.state) {
		case "ok":
		case "partial":
		case "stale":
		case "failed":
		case "pending":
			return s.checkedAt ? ago(s.checkedAt) : "never";
		case "never":
			return "never";
		case "not_connected":
			return "off";
		case "unsupported":
			return "";
	}
}

// The why the color can't show, for a tooltip.
export function feedWhy(s: FeedStatus): string {
	switch (s.state) {
		case "ok":
			return `All read ${ago(s.checkedAt)}`;
		case "partial":
			return `${s.problems} ${s.problems === 1 ? "problem" : "problems"}: ${s.detail}`;
		case "failed":
			return `Failing since ${ago(s.failingSince)}: ${s.error}`;
		case "pending":
			return "Waiting on the marketplace's report";
		case "stale":
			return `Not read since ${ago(s.checkedAt)}; last tried ${ago(s.attemptedAt)}`;
		case "never":
			return "Not read yet";
		case "not_connected":
			return "Not connected";
		case "unsupported":
			return "Not a feed on this channel";
	}
}

export function FeedDot({
	status,
	className,
}: {
	status: FeedStatus;
	className?: string;
}) {
	const tone = feedTone(status);
	if (!tone) return <span className={cn("text-faint", className)}>–</span>;
	return (
		<span
			className={cn(
				"inline-block size-2 shrink-0 rounded-full",
				tone === "neutral" ? "bg-faint" : DOT[tone],
				status.state === "failed" && "animate-pulse",
				className,
			)}
		/>
	);
}
