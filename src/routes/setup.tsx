import { createFileRoute } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { addDevice, guessDeviceName, setupLinkFor } from "#/auth/client";
import { AuthCard } from "#/components/auth-card";
import { Button } from "#/components/ui/button";

// Where a setup link lands: it says whose device this becomes, then names
// the device and creates its passkey for that person.
export const Route = createFileRoute("/setup")({
	validateSearch: (search: Record<string, unknown>): { token?: string } =>
		typeof search.token === "string" ? { token: search.token } : {},
	head: () => ({ meta: [{ title: "Add this device · katasync" }] }),
	component: Setup,
});

type Link =
	| { kind: "checking" }
	| { kind: "ready"; staffName: string }
	| { kind: "refused"; message: string };

type Attempt =
	| { kind: "idle" }
	| { kind: "busy" }
	| { kind: "failed"; message: string };

const messageOf = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

function Setup() {
	const { token } = Route.useSearch();
	const [name, setName] = useState("");
	const [link, setLink] = useState<Link>({ kind: "checking" });
	const [attempt, setAttempt] = useState<Attempt>({ kind: "idle" });
	useEffect(() => setName(guessDeviceName()), []);
	useEffect(() => {
		if (!token) return;
		let current = true;
		setupLinkFor(token).then(
			({ staffName }) => current && setLink({ kind: "ready", staffName }),
			(err) => current && setLink({ kind: "refused", message: messageOf(err) }),
		);
		return () => {
			current = false;
		};
	}, [token]);

	if (!token || link.kind === "refused")
		return (
			<AuthCard title="Add this device">
				<p className="text-critical-text">
					{link.kind === "refused"
						? link.message
						: "Link is incomplete. Open the whole link."}
				</p>
			</AuthCard>
		);

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (!token || attempt.kind === "busy") return;
		setAttempt({ kind: "busy" });
		try {
			await addDevice(token, name);
			window.location.assign("/");
		} catch (err) {
			setAttempt({ kind: "failed", message: messageOf(err) });
		}
	}

	return (
		<AuthCard
			title={
				link.kind === "ready"
					? `Add a device for ${link.staffName}`
					: "Add this device"
			}
		>
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
				<Button
					size="lg"
					type="submit"
					disabled={
						link.kind !== "ready" ||
						attempt.kind === "busy" ||
						name.trim() === ""
					}
				>
					<KeyRound />
					{attempt.kind === "busy" ? "Waiting for passkey…" : "Create passkey"}
				</Button>
				{attempt.kind === "failed" && (
					<p className="text-critical-text">{attempt.message}</p>
				)}
			</form>
		</AuthCard>
	);
}
