import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { AuthorizeParams } from "#/auth/oauth";
import { AuthCard } from "#/components/auth-card";
import { Button } from "#/components/ui/button";
import { answerAuthorization, checkAuthorization } from "#/server/auth";

// Where an MCP client like Claude sends someone to approve it. Needs a
// signed-in device, so a signed-out browser signs in first and comes back.
// The request is checked again on approval (src/auth/oauth.ts).

const KEYS = [
	"response_type",
	"client_id",
	"redirect_uri",
	"code_challenge",
	"code_challenge_method",
	"state",
	"resource",
] as const;

export const Route = createFileRoute("/oauth/authorize")({
	validateSearch: (search: Record<string, unknown>): AuthorizeParams =>
		Object.fromEntries(
			KEYS.flatMap((k) =>
				typeof search[k] === "string" ? [[k, search[k]]] : [],
			),
		),
	loaderDeps: ({ search }) => search,
	loader: ({ deps }) => checkAuthorization({ data: deps }),
	// Another site can't frame this page to trick a click on Approve, and the
	// code in the address isn't sent on as a referrer.
	headers: () => ({
		"Content-Security-Policy": "frame-ancestors 'none'",
		"X-Frame-Options": "DENY",
		"Referrer-Policy": "no-referrer",
	}),
	head: () => ({ meta: [{ title: "Connect an app · katasync" }] }),
	component: Authorize,
});

function Authorize() {
	const check = Route.useLoaderData();
	const params = Route.useSearch();
	const [canWrite, setCanWrite] = useState(true);
	const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
	const [error, setError] = useState<string | null>(null);

	// The app asked wrongly; it's told so at its own address.
	useEffect(() => {
		if (check.kind === "refused") window.location.replace(check.redirect);
	}, [check]);

	if (check.kind === "invalid")
		return (
			<AuthCard title="Can't connect">
				<p className="text-critical-text">{check.message}</p>
			</AuthCard>
		);
	if (check.kind === "refused")
		return (
			<AuthCard title="Can't connect">
				<p className="text-muted-foreground">Sending you back to the app…</p>
			</AuthCard>
		);

	async function answer(approve: boolean) {
		setBusy(approve ? "approve" : "deny");
		setError(null);
		try {
			const r = await answerAuthorization({
				data: {
					params,
					answer: approve ? { approve: true, canWrite } : { approve: false },
				},
			});
			if (r.kind === "invalid") {
				setError(r.message);
				setBusy(null);
				return;
			}
			// Stays busy: the browser is leaving for the app.
			window.location.assign(r.url);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(null);
		}
	}

	return (
		<AuthCard title={`Connect ${check.clientName}?`}>
			<p>
				It will use katasync's tools as you. Sending POs and buying labels stay
				in the app.
			</p>
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-1 text-muted-foreground">What it can do</legend>
				{[
					{ value: true, label: "Read and make changes" },
					{ value: false, label: "Read only" },
				].map((o) => (
					<label key={o.label} className="flex items-center gap-2">
						<input
							type="radio"
							name="access"
							checked={canWrite === o.value}
							onChange={() => setCanWrite(o.value)}
						/>
						{o.label}
					</label>
				))}
			</fieldset>
			<div className="flex gap-2">
				<Button
					size="lg"
					className="flex-1"
					autoFocus
					disabled={busy !== null}
					onClick={() => answer(true)}
				>
					{busy === "approve" ? "Connecting…" : "Approve"}
				</Button>
				<Button
					size="lg"
					variant="outline"
					disabled={busy !== null}
					onClick={() => answer(false)}
				>
					{busy === "deny" ? "Declining…" : "Deny"}
				</Button>
			</div>
			{error && <p className="text-critical-text">{error}</p>}
			<p className="text-muted-foreground">
				Then you'll go back to {check.redirectHost}. Disconnect it any time in
				Settings.
			</p>
		</AuthCard>
	);
}
