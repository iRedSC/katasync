import { useEffect, useState } from "react";
import { cn } from "#/lib/utils";
import { bigInput } from "./constants";
import { Spinner } from "./spinner";
import type { Found } from "./types";

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
	const [preview, setPreview] = useState<Found | null | "loading">(null);

	// Every keystroke looks the pin up, so Enter usually has nothing to wait
	// for. lookUp caches by pin, so only the typed value matters here.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		if (!value) return setPreview(null);
		let current = true;
		setPreview("loading");
		lookUp(Number(value))
			.then((f) => current && setPreview(f))
			.catch(() => current && setPreview(null));
		return () => {
			current = false;
		};
	}, [value]);

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
				{preview === "loading" && <Spinner />}
				{preview && preview !== "loading" && (
					<span>
						<span className="font-semibold">{preview.order.name}</span>
						<span className="text-muted-foreground">
							{" "}
							· {preview.order.customerName ?? "No name"} ·{" "}
							{preview.plan.lines.reduce((n, l) => n + l.quantity, 0)} items
							{preview.external && ` · ships on ${preview.external.name}`}
						</span>
					</span>
				)}
				{preview === null && value && (
					<span className="text-critical-text">No order has that pin</span>
				)}
			</div>
		</div>
	);
}
