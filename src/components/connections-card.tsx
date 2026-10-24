import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge, Card } from "#/components/page";
import { IconAction, Row } from "#/components/rows";
import { Button } from "#/components/ui/button";
import { formatDay } from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import { disconnectApp, type listConnections } from "#/server/auth";

type Connections = Awaited<ReturnType<typeof listConnections>>;
type App = Connections["apps"][number];

// Disconnecting shows at once, from this list.
export const connectionsData = optimistic<App[]>("connections");

// Agents (Claude and other MCP clients) connected to /mcp. Each connects itself: given the address, it opens
// katasync to sign in and approve it (src/routes/oauth/authorize.tsx).
export function ConnectionsCard({
	endpoint,
	apps,
	canAdminister,
}: {
	endpoint: string;
	apps: App[];
	canAdminister: boolean;
}) {
	async function remove(a: App) {
		if (
			!confirm(`Disconnect ${a.name}? It stops working until approved again.`)
		)
			return;
		const r = await optimism.change({
			label: `Disconnecting ${a.name}`,
			patch: connectionsData.patch("all", (list) =>
				list.filter((x) => x.id !== a.id),
			),
			send: () => disconnectApp({ data: { id: a.id } }),
		});
		if (r) toast.success(`Disconnected ${a.name}`);
	}

	const command = `claude mcp add --transport http katasync ${endpoint}`;
	const copy = (text: string) =>
		navigator.clipboard.writeText(text).then(() => toast.success("Copied"));

	return (
		<Card title="Agents" flush>
			<div className="flex flex-col gap-2 px-4 pb-3">
				<p>
					In Claude, add a custom connector with this address. You'll approve it
					here.
				</p>
				<div className="flex items-center gap-2">
					<code className="flex-1 rounded bg-surface px-2 py-1.5 text-xs break-all">
						{endpoint}
					</code>
					<Button size="sm" variant="outline" onClick={() => copy(endpoint)}>
						Copy
					</Button>
				</div>
				<p className="text-muted-foreground">For Claude Code, run:</p>
				<div className="flex items-center gap-2">
					<code className="flex-1 rounded bg-surface px-2 py-1.5 text-xs break-all">
						{command}
					</code>
					<Button size="sm" variant="outline" onClick={() => copy(command)}>
						Copy
					</Button>
				</div>
			</div>
			{apps.length === 0 ? (
				<p className="border-t px-4 py-3 text-muted-foreground">
					None connected.
				</p>
			) : (
				<ul>
					{apps.map((a) => (
						<Row
							key={a.id}
							actions={
								canAdminister && (
									<IconAction
										icon={Trash2}
										label="Disconnect"
										onClick={() => remove(a)}
									/>
								)
							}
						>
							<div className="min-w-0 flex-1">
								<p className="flex items-center gap-2 font-medium">
									<span className="truncate">{a.name}</span>
									{!a.canWrite && <Badge>Read only</Badge>}
								</p>
								<p className="text-xs text-muted-foreground">
									{a.lastUsedAt
										? `Used ${formatDay(a.lastUsedAt)}`
										: `Connected ${formatDay(a.createdAt)}, not used yet`}
								</p>
							</div>
						</Row>
					))}
				</ul>
			)}
		</Card>
	);
}
