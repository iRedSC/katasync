import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Badge, Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatDay } from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import { createToken, type listTokens, revokeToken } from "#/server/auth";

type Token = Awaited<ReturnType<typeof listTokens>>[number];

// Revoking shows at once, from this list.
export const tokensData = optimistic<Token[]>("tokens");

// API tokens for Claude and other MCP clients. A new token is shown once,
// with the command that connects Claude Code to katasync.
export function TokensCard({ tokens }: { tokens: Token[] }) {
	const [naming, setNaming] = useState(false);
	const [making, setMaking] = useState(false);
	const [made, setMade] = useState<{ token: string; endpoint: string } | null>(
		null,
	);

	// The token comes back from the server, so the form waits for it.
	async function create(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const name = String(form.get("name") ?? "");
		const canWrite = form.get("access") === "write";
		setMaking(true);
		const r = await optimism.change({
			send: () => createToken({ data: { name, canWrite } }),
		});
		setMaking(false);
		if (!r) return;
		setMade(r.value);
		setNaming(false);
	}

	async function revoke(t: Token) {
		if (!confirm(`Revoke ${t.name}? Anything using it stops working.`)) return;
		const r = await optimism.change({
			label: `Revoking ${t.name}`,
			patch: tokensData.patch("all", (list) =>
				list.filter((x) => x.id !== t.id),
			),
			send: () => revokeToken({ data: { id: t.id } }),
		});
		if (r) toast.success(`Revoked ${t.name}`);
	}

	const command =
		made &&
		`claude mcp add --transport http katasync ${made.endpoint} --header "Authorization: Bearer ${made.token}"`;

	return (
		<Card
			title="Claude and other MCP clients"
			flush
			aside={
				!naming &&
				!made && (
					<Button size="sm" variant="outline" onClick={() => setNaming(true)}>
						Make a token
					</Button>
				)
			}
		>
			{naming && (
				<form onSubmit={create} className="flex gap-2 border-t px-4 py-3">
					<input
						name="name"
						// biome-ignore lint/a11y/noAutofocus: opened to type a name
						autoFocus
						placeholder="Name, e.g. Office PC"
						onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
						className="h-8 flex-1 rounded-lg border border-input bg-white px-2 outline-none focus:border-ring"
					/>
					<select
						name="access"
						aria-label="What it can do"
						defaultValue="write"
						className="h-8 rounded-lg border border-input bg-white px-2"
					>
						<option value="write">Can make changes</option>
						<option value="read">Read only</option>
					</select>
					<Button type="submit" size="sm" disabled={making}>
						{making ? "Making…" : "Make"}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => setNaming(false)}
					>
						Cancel
					</Button>
				</form>
			)}
			{made && command && (
				<div className="flex flex-col gap-2 border-t px-4 py-3">
					<p>Shown once. For Claude Code, run:</p>
					<code className="rounded bg-surface px-2 py-1.5 text-xs break-all">
						{command}
					</code>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="outline"
							onClick={() =>
								navigator.clipboard
									.writeText(command)
									.then(() => toast.success("Copied"))
							}
						>
							Copy command
						</Button>
						<Button
							size="sm"
							variant="outline"
							onClick={() =>
								navigator.clipboard
									.writeText(made.token)
									.then(() => toast.success("Copied"))
							}
						>
							Copy token only
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setMade(null)}>
							Done
						</Button>
					</div>
				</div>
			)}
			{tokens.length === 0 ? (
				<p className="border-t px-4 py-3 text-muted-foreground">
					None. Sending POs and buying labels stay in the app.
				</p>
			) : (
				<ul>
					{tokens.map((t) => (
						<li
							key={t.id}
							className="flex items-center gap-3 border-t px-4 py-3"
						>
							<span className="flex flex-1 items-center gap-2 font-medium">
								{t.name}
								{!t.canWrite && <Badge>Read only</Badge>}
							</span>
							<span className="text-muted-foreground">
								{t.lastUsedAt
									? `Last used ${formatDay(t.lastUsedAt)}`
									: `Made ${formatDay(t.createdAt)}, not used yet`}
							</span>
							<Button size="sm" variant="ghost" onClick={() => revoke(t)}>
								Revoke
							</Button>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}
