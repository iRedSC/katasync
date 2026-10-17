import { createFileRoute } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { safeNext, signIn } from "#/auth/client";
import { AuthCard } from "#/components/auth-card";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/login")({
	validateSearch: (search: Record<string, unknown>): { next?: string } =>
		typeof search.next === "string" ? { next: search.next } : {},
	head: () => ({ meta: [{ title: "Sign in · katasync" }] }),
	component: Login,
});

function Login() {
	const { next } = Route.useSearch();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function go() {
		setBusy(true);
		setError(null);
		try {
			await signIn();
			// A full load, so the app starts fresh with the new session.
			window.location.assign(safeNext(next));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	}

	return (
		<AuthCard title="Sign in">
			<Button size="lg" autoFocus disabled={busy} onClick={go}>
				<KeyRound />
				{busy ? "Waiting for passkey…" : "Sign in with passkey"}
			</Button>
			{error && <p className="text-critical-text">{error}</p>}
			<p className="text-muted-foreground">
				New device? Add it from Settings on a signed-in one.
			</p>
		</AuthCard>
	);
}
