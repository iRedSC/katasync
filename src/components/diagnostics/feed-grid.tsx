import { FEED_NAMES, FeedDot, feedWhen, feedWhy } from "#/components/feed-dot";
import { Card } from "#/components/page";
import { Tip } from "#/components/ui/tooltip";
import type { CheckTarget } from "#/diagnostics/checks";
import { ALL_FEEDS } from "#/diagnostics/feed-health";
import { channelName } from "#/lib/format";
import type { Diagnostics } from "#/server/diagnostics";

// Every channel's feeds side by side: when each last read everything, and
// how it went. A failure stays until that same feed reads again, so a clean
// orders pass can't hide a returns failure.
export function FeedGrid({
	d,
	open,
}: {
	d: Diagnostics;
	open: (target: CheckTarget) => void;
}) {
	return (
		<Card flush>
			<table className="w-full text-sm whitespace-nowrap">
				<thead>
					<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium" />
						{ALL_FEEDS.map((f) => (
							<th key={f} className="px-3 py-2 font-medium">
								{FEED_NAMES[f]}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{d.channels.map((c) => (
						<tr key={c.channel} className="border-b last:border-0">
							<td className="px-4 py-2 font-medium">
								{channelName(c.channel)}
							</td>
							{c.feeds.map((f) => (
								<td key={f.feed} className="px-3 py-1">
									<Tip
										content={
											f.hint ? `${feedWhy(f)}\n${f.hint.title}` : feedWhy(f)
										}
										contentClassName="max-w-sm whitespace-pre-line"
									>
										<button
											type="button"
											onClick={() => open(c.channel)}
											className="flex items-center gap-1.5 rounded-md px-1 py-1 text-xs text-muted-foreground tabular-nums hover:bg-subtle"
										>
											<FeedDot status={f} />
											{feedWhen(f)}
										</button>
									</Tip>
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</Card>
	);
}
