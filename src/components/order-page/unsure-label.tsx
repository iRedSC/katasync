import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { optimism } from "#/lib/optimism";
import type { OrderDetail } from "#/server/orders";
import { checkLabel } from "#/server/shipping";

type Send = OrderDetail["sends"][number];

const providerName = (p: string) => (p === "tiktok" ? "TikTok" : "Shippo");

// A box whose purchase got no answer: it may be charged, so this order gets
// no new label until the provider shows this purchase bought or refused.
// Finding nothing settles nothing.
export function UnsureLabel({
	attempt: a,
	many,
}: {
	attempt: Send["attempts"][number];
	many: boolean;
}) {
	const [busy, setBusy] = useState(false);
	const name = providerName(a.provider);

	async function act(work: () => Promise<string>) {
		setBusy(true);
		const r = await optimism.change({ send: work });
		setBusy(false);
		if (r) toast.success(r.value);
	}

	const found =
		a.lastLookup === "none"
			? `${name} shows nothing for it yet; it may still be charged`
			: a.lastLookup === "pending"
				? `${name} shows something katasync can't settle; look in ${name}`
				: `No answer from ${name}; it may be charged`;

	return (
		<li className="flex flex-col gap-1 rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-xs">
			<p className="font-medium text-warning-text">
				{many && `Box ${a.boxIndex + 1}: `}
				{found}
			</p>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={() =>
						act(async () => {
							const r = await checkLabel({ data: { attemptId: a.id } });
							if (r.state === "succeeded")
								return r.handoff?.message ?? "Found it; label recorded";
							if (r.state === "failed")
								return `Not bought (${r.error}); ship it again`;
							throw new Error(
								r.lastLookup === "pending"
									? `${name} shows something katasync can't settle`
									: `${name} shows nothing for it yet`,
							);
						})
					}
				>
					Check {name}
				</Button>
			</div>
		</li>
	);
}

type Hold = NonNullable<Send["hold"]>;

// Why the handoff is held, shown as what to fix: the lines that changed
// since packing (packed, then now), or what katasync can't check.
export function HoldNote({ hold }: { hold: Hold }) {
	const box =
		"flex flex-col gap-0.5 rounded-md border border-critical-border bg-critical-surface px-3 py-2 text-xs";
	if (hold.kind === "drift") {
		return (
			<ul className={box}>
				{hold.drift.map((d) => (
					<li key={d.line} className="flex items-center justify-between gap-3">
						<span className="truncate">{d.title}</span>
						<span className="shrink-0 tabular-nums">
							{d.packed} packed →{" "}
							<span className="font-semibold text-critical-text">
								{d.open} now
							</span>
						</span>
					</li>
				))}
			</ul>
		);
	}
	return (
		<p className={`${box} text-critical-text`}>
			{hold.kind === "unknownContents"
				? "Bought before katasync kept what was packed"
				: hold.why}
		</p>
	);
}

export const holdBadge = (hold: Hold) =>
	hold.kind === "drift"
		? "Order changed"
		: hold.kind === "unknownContents"
			? "Contents unknown"
			: "Held";
