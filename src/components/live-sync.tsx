import { useRouter } from "@tanstack/react-router";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { channelName, formatTime } from "#/lib/format";
import { type SyncedNow, syncChannels } from "#/server/sync";

// Asks the marketplaces for new orders when a page opens, then reloads the
// page with what came in. With `repeat` (the orders page) it asks again every
// two minutes while someone is using it. The crons only run every four hours,
// so the database can sleep while nobody is looking. A hidden tab or ten
// minutes without input pauses it; coming back syncs at once if it's due.
// A channel another pass is syncing is asked again shortly, a few times, so
// the page picks up that pass's completion rather than waiting for the next ask.

const EVERY_MS = 2 * 60_000;
const IDLE_AFTER_MS = 10 * 60_000;
const BUSY_AGAIN_MS = 5_000;
const BUSY_TRIES = 30;

type Failed = { channel: string; error: string };
type Status =
	| { kind: "syncing"; lastAt: Date | null }
	// `lastAt` is the newest completion the server reported, never the time
	// this request returned. `busy` channels are held by another pass.
	| { kind: "synced"; lastAt: Date | null; failed: Failed[]; busy: string[] }
	// The request itself failed: offline, signed out, the server down.
	| { kind: "unreachable"; lastAt: Date | null; error: string }
	| { kind: "paused"; lastAt: Date | null };

export function LiveSync({ repeat }: { repeat: boolean }) {
	const router = useRouter();
	const [status, setStatus] = useState<Status>({
		kind: "syncing",
		lastAt: null,
	});
	const running = useRef(false);
	const lastRun = useRef(0);
	const lastInput = useRef(Date.now());
	const paused = useRef(false);
	const busyTries = useRef(0);
	const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	const sync = useCallback(
		async (now: boolean): Promise<void> => {
			if (running.current) return;
			running.current = true;
			lastRun.current = Date.now();
			clearTimeout(busyTimer.current);
			if (now) busyTries.current = 0;
			setStatus((s) => ({ kind: "syncing", lastAt: s.lastAt }));
			try {
				const passes = await syncChannels({ data: { now } });
				const done = completedAt(passes);
				const busy = busyOf(passes);
				setStatus((s) => ({
					kind: "synced",
					lastAt: done ?? s.lastAt,
					failed: failedOf(passes),
					busy,
				}));
				if (done) await router.invalidate();
				if (busy.length === 0) busyTries.current = 0;
				else if (busyTries.current < BUSY_TRIES) {
					busyTries.current++;
					busyTimer.current = setTimeout(() => void sync(false), BUSY_AGAIN_MS);
				}
			} catch (error) {
				setStatus((s) => ({
					kind: "unreachable",
					lastAt: s.lastAt,
					error: error instanceof Error ? error.message : String(error),
				}));
			} finally {
				running.current = false;
			}
		},
		[router],
	);

	useEffect(() => {
		const active = () =>
			document.visibilityState === "visible" &&
			Date.now() - lastInput.current < IDLE_AFTER_MS;
		const tick = () => {
			// Without repeat, one sync when the page opens is all it does.
			const ran = lastRun.current > 0;
			if (!repeat && ran) return;
			if (!active()) {
				paused.current = true;
				// A sync already under way shows until it ends.
				if (!running.current)
					setStatus((s) => ({ kind: "paused", lastAt: s.lastAt }));
				return;
			}
			// Back from a pause syncs at once, so "paused" never stays up while
			// it's running again. The server skips a channel synced moments ago.
			if (!ran || paused.current || Date.now() - lastRun.current >= EVERY_MS) {
				paused.current = false;
				void sync(false);
			}
		};
		// Input after an idle spell, or the tab coming back, syncs at once if
		// one is due rather than waiting for the next tick.
		const input = () => {
			const wasIdle = Date.now() - lastInput.current >= IDLE_AFTER_MS;
			lastInput.current = Date.now();
			if (wasIdle) tick();
		};
		const events = ["pointerdown", "keydown", "wheel", "pointermove"] as const;
		for (const e of events)
			window.addEventListener(e, input, { passive: true });
		document.addEventListener("visibilitychange", tick);
		const timer = setInterval(tick, 15_000);
		tick();
		return () => {
			for (const e of events) window.removeEventListener(e, input);
			document.removeEventListener("visibilitychange", tick);
			clearInterval(timer);
			clearTimeout(busyTimer.current);
		};
	}, [sync, repeat]);

	const lastAt = status.lastAt;
	const since = lastAt ? `Last synced ${formatTime(lastAt)}` : "Not synced yet";
	const [icon, label, tip] =
		status.kind === "syncing"
			? [<Loader2 key="i" className="animate-spin" />, "Syncing", since]
			: status.kind === "paused"
				? [
						<RefreshCw key="i" />,
						lastAt ? `Synced ${formatTime(lastAt)}` : "Sync",
						"Paused while this page isn't in use. Click to sync now",
					]
				: status.kind === "unreachable"
					? [
							<AlertCircle key="i" className="text-critical-text" />,
							"Couldn't sync",
							`${status.error}. Click to try again`,
						]
					: status.failed.length > 0
						? [
								<AlertCircle key="i" className="text-critical-text" />,
								`${status.failed.map((f) => channelName(f.channel)).join(", ")} didn't sync`,
								`${status.failed.map((f) => `${channelName(f.channel)}: ${f.error}`).join("\n")}\nDiagnostics has details. Click to try again`,
							]
						: status.busy.length > 0
							? [
									<Loader2 key="i" className="animate-spin" />,
									"Syncing",
									`${status.busy.map(channelName).join(", ")} is being synced by another pass. Click to check again`,
								]
							: lastAt
								? [
										<RefreshCw key="i" />,
										`Synced ${formatTime(lastAt)}`,
										repeat
											? "Orders sync every two minutes while you're here. Click to sync now"
											: "Synced when this page opened. Click to sync again",
									]
								: [
										<RefreshCw key="i" />,
										"Nothing to sync",
										"No marketplace is connected. Diagnostics says why",
									];

	return (
		<Tip content={<span className="whitespace-pre-line">{tip}</span>}>
			<Button
				variant="ghost"
				size="sm"
				disabled={status.kind === "syncing"}
				onClick={() => {
					lastInput.current = Date.now();
					void sync(true);
				}}
			>
				{icon}
				{label}
			</Button>
		</Tip>
	);
}

// The newest completion in these results, if any pass completed.
function completedAt(passes: SyncedNow[]): Date | null {
	const times = passes.flatMap((p) =>
		p.state === "ran" || p.state === "fresh" ? [p.at.getTime()] : [],
	);
	return times.length > 0 ? new Date(Math.max(...times)) : null;
}

function busyOf(passes: SyncedNow[]): string[] {
	return passes.flatMap((p) => (p.state === "busy" ? [p.channel] : []));
}

function failedOf(passes: SyncedNow[]): Failed[] {
	return passes.flatMap((p) =>
		p.state === "failed" ? [{ channel: p.channel, error: p.error }] : [],
	);
}
