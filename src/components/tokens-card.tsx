import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatDay } from "#/lib/format";
import { createToken, type listTokens, revokeToken } from "#/server/auth";

type Token = Awaited<ReturnType<typeof listTokens>>[number];

const message = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

// API tokens for Claude and other MCP clients. A new token is shown once,
// with the command that connects Claude Code to katasync.
export function TokensCard({ tokens }: { tokens: Token[] }) {
	const router = useRouter();
	const [naming, setNaming] = useState(false);
	const [made, setMade] = useState<{ token: string; endpoint: string } | null>(
		null,
	);

	async function create(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const name = String(new FormData(e.currentTarget).get("name") ?? "");
		try {
			setMade(await createToken({ data: { name } }));
			setNaming(false);
			await router.invalidate();
		} catch (err) {
			toast.error(message(err));
		}
	}

	async function revoke(t: Token) {
		if (!confirm(`Revoke ${t.name}? Anything using it stops working.`)) return;
		try {
			await revokeToken({ data: { id: t.id } });
			await router.invalidate();
			toast.success(`Revoked ${t.name}`);
		} catch (err) {
			toast.error(message(err));
		}
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
						placeholder="What it's for, e.g. Claude on the office PC"
						onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
						className="h-8 flex-1 rounded-lg border border-input bg-white px-2 outline-none focus:border-ring"
					/>
					<Button type="submit" size="sm">
						Make
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
					<p>
						Copy this now; katasync won't show the token again. To connect
						Claude Code, run:
					</p>
					<code className="rounded bg-[#f1f1f1] px-2 py-1.5 text-xs break-all">
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
					No tokens. Make one to let Claude read katasync, draft POs, and update
					the catalog and stock. Sending POs and buying labels stay in the app.
				</p>
			) : (
				<ul>
					{tokens.map((t) => (
						<li
							key={t.id}
							className="flex items-center gap-3 border-t px-4 py-3"
						>
							<span className="flex-1 font-medium">{t.name}</span>
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
