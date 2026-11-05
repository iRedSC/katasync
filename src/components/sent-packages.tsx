import { useEffect, useState } from "react";
import { Badge } from "#/components/page";
import { Notice } from "#/components/quick-ship/notice";
import { Spinner } from "#/components/quick-ship/spinner";
import { formatDate, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import { printLabels } from "#/printing/qz-client";
import { addressedVoid, listSentPackages } from "#/server/shipping";

type Sent = Awaited<ReturnType<typeof listSentPackages>>[number];

// Packages sent to an address, newest first, each with Print and Void.
export function SentPackages() {
	const [list, setList] = useState<Sent[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		listSentPackages().then(setList, (err: unknown) =>
			setError(err instanceof Error ? err.message : "Couldn't load"),
		);
	}, []);

	if (error) return <Notice tone="critical">{error}</Notice>;
	if (!list)
		return (
			<div className="flex justify-center py-8 text-muted-foreground">
				<Spinner />
			</div>
		);
	if (list.length === 0)
		return (
			<p className="py-8 text-center text-muted-foreground">Nothing sent yet</p>
		);
	return (
		<ul className="flex flex-col divide-y divide-border">
			{list.map((p) => (
				<Row
					key={p.shipmentId}
					sent={p}
					onVoided={(refundStatus) =>
						setList((old) =>
							(old ?? []).map((o) =>
								o.shipmentId === p.shipmentId
									? { ...o, voidedAt: new Date(), refundStatus }
									: o,
							),
						)
					}
				/>
			))}
		</ul>
	);
}

function Row({
	sent,
	onVoided,
}: {
	sent: Sent;
	onVoided: (refundStatus: string) => void;
}) {
	const [voiding, setVoiding] = useState<"ask" | "busy" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const voided = sent.voidedAt !== null;
	const { sentTo: to } = sent;

	async function confirmVoid() {
		setVoiding("busy");
		setError(null);
		try {
			const { refundStatus } = await addressedVoid({
				data: { dispatchId: sent.dispatchId },
			});
			onVoided(refundStatus);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Void failed");
		}
		setVoiding(null);
	}

	return (
		<li className="flex flex-col gap-1 py-2.5">
			<div className="flex items-baseline justify-between gap-3">
				<span className={cn("font-semibold", voided && "line-through")}>
					{to.name}
				</span>
				<span className="shrink-0 text-muted-foreground tabular-nums">
					{formatDate(sent.createdAt)}
				</span>
			</div>
			<div className="text-muted-foreground">
				{to.street1}
				{to.street2 ? `, ${to.street2}` : ""}, {to.city} {to.state} {to.zip}
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className={cn(voided && "text-muted-foreground line-through")}>
					{sent.serviceName} · {formatMoney(sent.cost)}
				</span>
				{sent.trackingNumber &&
					(sent.trackingUrl ? (
						<a
							href={sent.trackingUrl}
							target="_blank"
							rel="noreferrer"
							className="font-mono text-link hover:underline"
						>
							{sent.trackingNumber}
						</a>
					) : (
						<span className="font-mono text-muted-foreground">
							{sent.trackingNumber}
						</span>
					))}
				{sent.test && <Badge tone="info">Test</Badge>}
				{voided ? (
					<Badge tone="warning">
						Voided
						{sent.refundStatus
							? `, refund ${sent.refundStatus.toLowerCase()}`
							: ""}
					</Badge>
				) : (
					<span className="ml-auto flex items-center gap-3">
						<button
							type="button"
							onClick={() => printLabels([sent.shipmentId])}
							className="text-link hover:underline"
						>
							Print
						</button>
						{voiding === "ask" ? (
							<button
								type="button"
								onClick={confirmVoid}
								className="font-semibold text-critical-text hover:underline"
							>
								Refund {formatMoney(sent.cost)}?
							</button>
						) : (
							<button
								type="button"
								disabled={voiding === "busy"}
								onClick={() => setVoiding("ask")}
								className="text-muted-foreground hover:underline"
							>
								{voiding === "busy" ? "Voiding…" : "Void"}
							</button>
						)}
					</span>
				)}
			</div>
			{error && <p className="text-critical-text">{error}</p>}
		</li>
	);
}
