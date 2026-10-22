import { useEffect, useState } from "react";
import { cn } from "#/lib/utils";
import { bigInput } from "./constants";
import { Spinner } from "./spinner";
import type { Found } from "./types";

// What the pin under the cursor is. Only "missing" says there's no such order;
// "failed" means the lookup itself didn't answer.
type Preview =
	| { state: "idle" }
	| { state: "loading" }
	| { state: "found"; found: Found }
	| { state: "missing" }
	| { state: "failed" };

export function PinStep({
	busy,
	lookUp,
	onSubmit,
}: {
	busy: boolean;
	lookUp: (pin: number) => Promise<Found | null>;
	onSubmit: (pin: number) => void;
}) {
	const [value, setValue] = useState("");
	const [attempt, setAttempt] = useState(0);
	const [preview, setPreview] = useState<Preview>({ state: "idle" });

	// Every keystroke looks the pin up, so Enter usually has nothing to wait
	// for. lookUp caches by pin, so only the typed value matters here; a retry
	// bumps attempt to look the same pin up again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		if (!value) return setPreview({ state: "idle" });
		let current = true;
		setPreview({ state: "loading" });
		lookUp(Number(value))
			.then(
				(f) =>
					current &&
					setPreview(f ? { state: "found", found: f } : { state: "missing" }),
			)
			.catch(() => current && setPreview({ state: "failed" }));
		return () => {
			current = false;
		};
	}, [value, attempt]);

	return (
		<div className="flex flex-col gap-3">
			<p className="text-center text-xl font-semibold">Order pin</p>
			<input
				// biome-ignore lint/a11y/noAutofocus: the modal exists to type this
				autoFocus
				inputMode="numeric"
				maxLength={3}
				disabled={busy}
				value={value}
				onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
				onKeyDown={(e) => {
					if (e.key === "Enter" && Number(value) > 0) onSubmit(Number(value));
				}}
				className={cn(bigInput, "tracking-[0.4em] placeholder:text-line")}
			/>
			<div className="flex h-8 items-center justify-center text-lg">
				{preview.state === "loading" && <Spinner />}
				{preview.state === "found" && (
					<span>
						<span className="font-semibold">{preview.found.order.name}</span>
						<span className="text-muted-foreground">
							{" "}
							· {preview.found.order.customerName ?? "No name"} ·{" "}
							{preview.found.plan.lines.reduce((n, l) => n + l.quantity, 0)}{" "}
							items
							{preview.found.external &&
								` · ships on ${preview.found.external.name}`}
						</span>
					</span>
				)}
				{preview.state === "missing" && (
					<span className="text-critical-text">No order has that pin</span>
				)}
				{preview.state === "failed" && (
					<button
						type="button"
						onClick={() => setAttempt((n) => n + 1)}
						className="text-critical-text underline underline-offset-2"
					>
						Couldn't check this pin. Retry
					</button>
				)}
			</div>
		</div>
	);
}
