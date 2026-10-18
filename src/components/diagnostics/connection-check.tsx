import {
	AlertTriangle,
	CheckCircle2,
	Loader2,
	PlayCircle,
	XCircle,
} from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { Button } from "#/components/ui/button";
import type { CheckTarget } from "#/diagnostics/checks";
import { optimism } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { runConnectionCheck } from "#/server/diagnostics";

// Live check results, kept per target outside React so they outlive the
// sheet closing.
type CheckResult = Awaited<ReturnType<typeof runConnectionCheck>>;
const results = new Map<CheckTarget, CheckResult>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function useCheck(target: CheckTarget) {
	const result = useSyncExternalStore(
		subscribe,
		() => results.get(target),
		() => undefined,
	);
	const [running, setRunning] = useState(false);
	async function run() {
		setRunning(true);
		// The result shows as soon as the server answers; the reload comes after.
		await optimism.change({
			send: async () => {
				const r = await runConnectionCheck({ data: { target } }).catch(
					(err: unknown) => {
						throw new Error(
							`Check failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					},
				);
				results.set(target, r);
				for (const listener of listeners) listener();
				return r;
			},
		});
		setRunning(false);
	}
	return { result, running, run };
}

export function CheckButton({ target }: { target: CheckTarget }) {
	const { running, run } = useCheck(target);
	return (
		<Button size="sm" variant="outline" disabled={running} onClick={run}>
			{running ? <Loader2 className="animate-spin" /> : <PlayCircle />}
			Run check
		</Button>
	);
}

export function CheckResults({ target }: { target: CheckTarget }) {
	const { result } = useCheck(target);
	if (!result) return null;
	return (
		<div className="rounded-lg border p-3">
			<p className="mb-2 font-medium">
				Check, {new Date(result.ranAt).toLocaleTimeString()}
			</p>
			<ol className="flex flex-col gap-1.5">
				{result.steps.map((step) => (
					<li key={step.label} className="flex gap-2">
						{step.status === "ok" ? (
							<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-icon" />
						) : step.status === "warn" ? (
							<AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-icon" />
						) : (
							<XCircle className="mt-0.5 size-4 shrink-0 text-critical-icon" />
						)}
						<div className="min-w-0">
							<span className="font-medium">{step.label}</span>{" "}
							<span className="text-xs text-muted-foreground">{step.ms}ms</span>
							<p
								className={cn(
									"font-mono text-xs break-words",
									step.status === "fail"
										? "text-critical-text"
										: "text-muted-foreground",
								)}
							>
								{step.detail}
							</p>
						</div>
					</li>
				))}
			</ol>
		</div>
	);
}
