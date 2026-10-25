import { AlertTriangle, PackageOpen } from "lucide-react";
import { ago } from "#/components/diagnostics/status";
import { FeedDot, feedWhy } from "#/components/feed-dot";
import { EmptyState } from "#/components/page";
import { Tip } from "#/components/ui/tooltip";
import type { FeedStatus } from "#/diagnostics/feed-health";
import { channelName } from "#/lib/format";

// When each marketplace's returns were last read, on the Returns tab: a dot
// per marketplace and how long ago the stalest of them read everything. An
// empty list is only "nothing due" when every one of them was read.

export type ReturnsCheck = { channel: string } & FeedStatus;

// Read in full up to lately, with nothing held or left unread. A feed with
// problems, catching up, or missing history isn't proof nothing's due.
const verified = (c: ReturnsCheck) => c.state === "ok";
// Not connected isn't a marketplace katasync sells on yet.
const counted = (checks: ReturnsCheck[]) =>
	checks.filter((c) => c.state !== "not_connected");

export function ReturnsChecked({ checks }: { checks: ReturnsCheck[] }) {
	const shown = counted(checks);
	if (shown.length === 0) return null;
	const times = shown.flatMap((c) =>
		c.state === "ok" ? [new Date(c.checkedAt).getTime()] : [],
	);
	const oldest =
		times.length === shown.length ? new Date(Math.min(...times)) : null;
	return (
		<span className="mr-2 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
			{shown.map((c) => (
				<Tip
					key={c.channel}
					content={`${channelName(c.channel)}: ${feedWhy(c)}`}
					contentClassName="max-w-sm"
				>
					<span className="flex size-3 items-center justify-center">
						<FeedDot status={c} />
					</span>
				</Tip>
			))}
			{oldest && ago(oldest)}
		</span>
	);
}

// The empty list, which says nothing's due only when every marketplace was
// read in full; otherwise which weren't.
export function NothingDue({ checks }: { checks: ReturnsCheck[] }) {
	const unread = counted(checks).filter((c) => !verified(c));
	if (unread.length === 0)
		return (
			<EmptyState icon={PackageOpen} title="Nothing to answer or receive">
				<ReturnsChecked checks={checks} />
			</EmptyState>
		);
	return (
		<EmptyState
			icon={AlertTriangle}
			title={`Couldn't fully check ${unread.map((c) => channelName(c.channel)).join(", ")}`}
		>
			<span className="flex justify-center">
				<ReturnsChecked checks={checks} />
			</span>
		</EmptyState>
	);
}
