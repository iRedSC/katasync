import { CircleCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "#/components/page";
import { formatMoney } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { printLabels } from "#/printing/qz-client";
import { voidLabel } from "#/server/shipping";
import { labelPath } from "#/shipping/label-path";
import { Notice } from "./notice";
import type { Bought } from "./types";

export function DoneStep({
	bought,
	onNext,
}: {
	bought: Bought;
	onNext: () => void;
}) {
	const next = useRef<HTMLButtonElement>(null);
	useEffect(() => next.current?.focus(), []);
	const [voiding, setVoiding] = useState<"ask" | "busy" | null>(null);
	const [voided, setVoided] = useState<string | null>(null);
	const [voidError, setVoidError] = useState<string | null>(null);
	const many = bought.boxes.length > 1;
	const handoff = bought.handoff;

	// Refunds money at the carrier, so it waits for the reload that shows it.
	async function confirmVoid() {
		setVoiding("busy");
		setVoidError(null);
		const r = await optimism.change({
			send: () => voidLabel({ data: { dispatchId: bought.dispatchId } }),
		});
		setVoiding(null);
		if (!r) return;
		const result = r.value;
		// Some refunds refused: stay here so voiding can be tried again.
		if (result.remaining > 0) {
			return setVoidError(result.notes.join(" "));
		}
		setVoided(
			[
				`${many ? "Labels" : "Label"} voided, refund ${result.refundStatus.toLowerCase()}.`,
				...result.notes,
			].join(" "),
		);
	}

	if (voided) {
		return (
			<div className="flex flex-col items-center gap-4 py-4 text-center">
				<p className="text-3xl font-bold">{many ? "Labels" : "Label"} voided</p>
				<p className="text-lg text-muted-foreground">{voided}</p>
				<button
					ref={next}
					type="button"
					onClick={onNext}
					className="h-14 rounded-xl bg-primary px-8 text-xl font-semibold text-white outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				>
					Next order
				</button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col items-center gap-3 rounded-xl bg-success-surface px-6 py-8 text-center">
				<CircleCheck className="size-16 text-success-icon" />
				<p className="text-4xl font-bold">
					{many ? `${bought.boxes.length} labels bought` : "Label bought"}
				</p>
				<p className="text-xl">
					{bought.serviceName} ·{" "}
					<span className="font-semibold">{formatMoney(bought.cost)}</span>
				</p>
				{bought.test && (
					<Badge tone="info">Test label: it won't ship anything</Badge>
				)}
				<ul className="flex flex-col gap-1">
					{bought.boxes.map((b, i) => (
						<li key={b.id} className="flex items-center justify-center gap-3">
							{many && (
								<a
									href={labelPath(b.id)}
									target="_blank"
									rel="noreferrer"
									className="text-lg text-link hover:underline"
								>
									Open box {i + 1} PDF
								</a>
							)}
							{b.trackingNumber && (
								<span className="font-mono text-muted-foreground">
									{b.trackingNumber}
								</span>
							)}
						</li>
					))}
				</ul>
				{handoff?.sent && (
					<p className="text-lg font-semibold text-success-text">
						{handoff.message}
					</p>
				)}
				<div className="mt-2 flex items-center gap-4">
					<button
						ref={next}
						type="button"
						onClick={onNext}
						className="h-14 rounded-xl bg-primary px-8 text-xl font-semibold text-white outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					>
						Next order
					</button>
					<button
						type="button"
						onClick={() => printLabels(bought.boxes.map((box) => box.id))}
						className="text-lg text-link hover:underline"
					>
						Print again
					</button>
					{/* TikTok has no API to cancel its labels. */}
					{bought.provider === "tiktok" ? (
						<span className="text-lg text-muted-foreground">
							Cancel in TikTok Seller Center
						</span>
					) : voiding === "ask" ? (
						<button
							type="button"
							onClick={confirmVoid}
							className="text-lg font-semibold text-critical-text hover:underline"
						>
							Void and refund {formatMoney(bought.cost)}?
						</button>
					) : (
						<button
							type="button"
							disabled={voiding === "busy"}
							onClick={() => setVoiding("ask")}
							className="text-lg text-muted-foreground hover:underline"
						>
							{voiding === "busy"
								? "Voiding…"
								: many
									? "Void all labels"
									: "Void label"}
						</button>
					)}
				</div>
			</div>
			{handoff && !handoff.sent && (
				<Notice tone={bought.test ? "info" : "critical"}>
					{handoff.message}
					{!bought.test &&
						". Retry from the order page; it stays on To ship until then."}
				</Notice>
			)}
			{voidError && <Notice tone="critical">{voidError}</Notice>}
		</div>
	);
}
