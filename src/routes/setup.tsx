import { createFileRoute } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { addDevice, guessDeviceName } from "#/auth/client";
import { AuthCard } from "#/components/auth-card";
import { Button } from "#/components/ui/button";

// Where a setup link lands: name this device and create its passkey.
export const Route = createFileRoute("/setup")({
	validateSearch: (search: Record<string, unknown>): { token?: string } =>
		typeof search.token === "string" ? { token: search.token } : {},
	head: () => ({ meta: [{ title: "Add this device · katasync" }] }),
	component: Setup,
});

function Setup() {
	const { token } = Route.useSearch();
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The user agent is only known in the browser.
	useEffect(() => setName(guessDeviceName()), []);

	if (!token)
		return (
			<AuthCard title="Add this device">
				<p className="text-critical-text">
					Link is incomplete. Open the whole link.
				</p>
			</AuthCard>
		);

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (!token) return;
		setBusy(true);
		setError(null);
		try {
			await addDevice(token, name);
			window.location.assign("/");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	}

	return (
		<AuthCard title="Add this device">
			<form onSubmit={submit} className="flex flex-col gap-3">
				<label className="flex flex-col gap-1">
					<span className="text-muted-foreground">Device name</span>
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="e.g. Warehouse iPhone"
						className="h-9 rounded-lg border border-input bg-white px-2 outline-none focus:border-ring"
					/>
				</label>
				<Button size="lg" type="submit" disabled={busy || name.trim() === ""}>
					<KeyRound />
					{busy ? "Waiting for passkey…" : "Create passkey"}
				</Button>
				{error && <p className="text-critical-text">{error}</p>}
			</form>
		</AuthCard>
	);
}
