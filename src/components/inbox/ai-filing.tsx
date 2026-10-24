import { Copy, Sparkles, Truck, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { FoldingFlags, ProposedFlags } from "#/components/purchase-order/flags";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatDay } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Applied, Proposal } from "#/purchasing/inbox/ai-filing-shapes";
import type { InboxPage } from "#/purchasing/inbox/views";

// What the AI made of a supplier's email, under its header: reading it, the
// tracking it followed and the flags it raised on the PO it filed it on
// (each applied or dismissed here; undo takes the email off), the PO it
// suggests (one click files it), the earlier email it set it aside as a copy
// of (undo brings it back), or why it found none.

type Email = InboxPage["emails"][number];

export function AiFiling({
	email: e,
	onTake,
	onUndo,
	onUndoAside,
}: {
	email: Email;
	onTake: (po: number) => void;
	onUndo: () => void;
	onUndoAside: () => void;
}) {
	const ai = e.ai;
	if (!ai) return null;
	const waiting = e.purchaseOrderId === null && e.setAsideAt === null;

	if (ai.state === "working" && waiting)
		return (
			<Box dashed>
				<Sparkles className="size-3.5 animate-pulse text-primary" />
				<span className="h-3 w-40 animate-pulse rounded bg-surface-strong" />
			</Box>
		);

	if (ai.state === "unmatched" && waiting && ai.reason)
		return (
			<Box dashed>
				<Sparkles className="size-3.5" />
				<span className="text-muted-foreground">{ai.reason}</span>
			</Box>
		);

	if (ai.state === "suggested" && waiting && ai.purchaseOrderId && ai.proposal)
		return (
			<Box>
				<Sparkles className="size-3.5 text-primary" />
				<Button
					size="sm"
					onClick={() => ai.purchaseOrderId && onTake(ai.purchaseOrderId)}
					className="tabular-nums"
				>
					PO {ai.purchaseOrderId}?
				</Button>
				<span className="text-muted-foreground">{ai.reason}</span>
				<ProposalChips proposal={ai.proposal} />
			</Box>
		);

	if (ai.state === "set_aside" && e.setAsideAt !== null && e.original)
		return (
			<Box>
				<Sparkles className="size-3.5 text-primary" />
				<Tip content={e.original.subject || "(no subject)"}>
					<span className="inline-flex items-center gap-1 rounded-md bg-surface-strong px-1.5 py-0.5 text-xs tabular-nums [&_svg]:size-3">
						<Copy />
						{formatDay(e.original.receivedAt)}
						{e.original.purchaseOrderId !== null &&
							` · PO ${e.original.purchaseOrderId}`}
					</span>
				</Tip>
				{ai.reason && (
					<span className="text-muted-foreground">{ai.reason}</span>
				)}
				<Button
					size="sm"
					variant="ghost"
					onClick={onUndoAside}
					className="ml-auto"
				>
					<Undo2 />
					Undo
				</Button>
			</Box>
		);

	if (ai.state === "filed" && ai.purchaseOrderId && ai.applied)
		return (
			<Box>
				<Sparkles className="size-3.5 text-primary" />
				{ai.reason && (
					<span className="text-muted-foreground">{ai.reason}</span>
				)}
				<AppliedChips applied={ai.applied} />
				<Button size="sm" variant="ghost" onClick={onUndo} className="ml-auto">
					<Undo2 />
					Undo
				</Button>
				{e.flags.length > 0 && (
					<div className="-mx-3 -mb-2 basis-full border-t">
						<FoldingFlags flags={e.flags} className="px-3 py-2" />
					</div>
				)}
			</Box>
		);

	return null;
}

function Box({ dashed, children }: { dashed?: boolean; children: ReactNode }) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-1.5 overflow-hidden rounded-xl border px-3 py-2 text-sm animate-in fade-in-0 slide-in-from-top-1",
				dashed ? "border-dashed" : "bg-surface",
			)}
		>
			{children}
		</div>
	);
}

function Chip({
	icon,
	tone,
	tip,
	children,
}: {
	icon?: ReactNode;
	tone?: "warning" | "muted";
	tip?: string;
	children: ReactNode;
}) {
	return (
		<Tip content={tip}>
			<span
				className={cn(
					"inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs tabular-nums [&_svg]:size-3",
					tone === "warning"
						? "bg-warning-surface text-warning-text"
						: tone === "muted"
							? "text-muted-foreground line-through"
							: "bg-surface-strong",
				)}
			>
				{icon}
				{children}
			</span>
		</Tip>
	);
}

// What filing it would do.
function ProposalChips({ proposal: p }: { proposal: Proposal }) {
	return (
		<>
			{p.tracking.map((t) => (
				<Chip key={t.number} icon={<Truck />}>
					{t.number}
				</Chip>
			))}
			<ProposedFlags flags={p.flags} />
		</>
	);
}

// What filing it did, and, struck through, what it couldn't and why.
function AppliedChips({ applied: a }: { applied: Applied }) {
	return (
		<>
			{a.tracking.map((n) => (
				<Chip key={n} icon={<Truck />}>
					{n}
				</Chip>
			))}
			{a.skipped.map((s) => (
				<Chip key={s.what} tone="muted" tip={s.why}>
					{s.what}
				</Chip>
			))}
		</>
	);
}
