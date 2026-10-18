import { useState } from "react";
import { Badge, Card } from "#/components/page";
import { formatCount, formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Diagnostics } from "#/server/diagnostics";

// What agents changed through /mcp, newest first. Arguments are what it
// asked for; the result is what katasync answered.
const AGENT_ROWS = 8;

export function AgentChanges({ calls }: { calls: Diagnostics["claude"] }) {
	const [open, setOpen] = useState<number | null>(null);
	const [all, setAll] = useState(false);
	const shown = all ? calls : calls.slice(0, AGENT_ROWS);
	return (
		<Card title="Agent changes" flush>
			{calls.length === 0 ? (
				<p className="px-4 pb-4 text-muted-foreground">None yet.</p>
			) : (
				<ul>
					{shown.map((c) => (
						<li key={c.id} className="border-t">
							<button
								type="button"
								onClick={() => setOpen(open === c.id ? null : c.id)}
								className="grid w-full grid-cols-[9rem_10rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-left hover:bg-subtle"
							>
								<span className="whitespace-nowrap text-muted-foreground">
									{formatDateTime(c.createdAt)}
								</span>
								<span className="truncate font-mono text-xs">{c.tool}</span>
								<span className="truncate font-mono text-xs text-muted-foreground">
									{c.arguments}
								</span>
								<Badge tone={c.ok ? "success" : "critical"}>
									{c.ok ? "Done" : "Failed"}
								</Badge>
							</button>
							{open === c.id && (
								<div className="flex flex-col gap-2 px-4 pb-3">
									<p className="text-xs text-muted-foreground">
										By {c.tokenName}
									</p>
									<pre className="max-h-48 overflow-auto rounded-lg bg-subtle p-2 font-mono text-xs break-words whitespace-pre-wrap">
										{JSON.stringify(JSON.parse(c.arguments), null, 1)}
									</pre>
									<pre
										className={cn(
											"max-h-48 overflow-auto rounded-lg p-2 font-mono text-xs break-words whitespace-pre-wrap",
											c.ok
												? "bg-subtle"
												: "bg-critical-surface text-critical-text",
										)}
									>
										{c.result}
									</pre>
								</div>
							)}
						</li>
					))}
					{calls.length > AGENT_ROWS && (
						<li className="border-t">
							<button
								type="button"
								onClick={() => setAll((a) => !a)}
								className="w-full px-4 py-2 text-left text-link hover:bg-subtle"
							>
								{all ? "Show fewer" : `Show all ${formatCount(calls.length)}`}
							</button>
						</li>
					)}
				</ul>
			)}
		</Card>
	);
}
