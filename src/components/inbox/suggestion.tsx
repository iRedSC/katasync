import { useRouter } from "@tanstack/react-router";
import { ArrowDown, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { draftFits } from "#/buyers/chat-way";
import type { BuyerThread } from "#/buyers/threads";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";
import { draftReplyNow } from "#/server/buyer-drafts";

// The reply suggested for a thread, above the reply box. The arrow pulls it
// into the box, to send as it is or change first: nothing here sends. Who wrote it shows as a
// chip; the precedents it followed and what to check sit under it.

type Draft = NonNullable<BuyerThread["draft"]>;

const BY: Record<Draft["by"], string> = {
	ai: "Suggested",
	claude: "From Claude",
	staff: "Saved by you",
};

export function Suggestion({
	thread: t,
	orderRef,
	ai,
	onEdit,
}: {
	thread: BuyerThread;
	// The order in view: a suggestion about another isn't offered, only
	// drafting one about this.
	orderRef: string | null;
	// Without the AI, a suggestion Claude or staff saved still shows, with
	// nothing to draft it again.
	ai: boolean;
	onEdit: (body: string, english: string | null) => void;
}) {
	const router = useRouter();
	const [redrafting, setRedrafting] = useState(false);
	const d = t.draft && draftFits(t.draft, orderRef) ? t.draft : null;
	// About another of the buyer's orders, so drafting is for this one.
	const elsewhere = t.draft !== null && d === null;
	// The version pulled into the box, which then leaves until a new one.
	const version = d?.updatedAt.toString() ?? "";
	const [pulled, setPulled] = useState<string | null>(null);
	if (elsewhere && ai && t.waiting)
		return redrafting ? (
			<Drafting />
		) : (
			<div className="mb-2 flex justify-end">
				<Button type="button" size="sm" variant="ghost" onClick={redraft}>
					<Sparkles />
					Suggest a reply about this order
				</Button>
			</div>
		);
	if (!t.waiting || !d || pulled === version) return null;
	// Drafting and failing are the agent's; without it, only a saved one shows.
	if (!ai && d.state !== "ready") return null;

	async function redraft() {
		setRedrafting(true);
		try {
			const d = await draftReplyNow({ data: { threadId: t.id, orderRef } });
			if (!d) toast("It's being drafted already");
			await router.invalidate();
		} catch (error) {
			toast.error("Couldn't draft it", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setRedrafting(false);
		}
	}

	if (d.state === "drafting" || redrafting) return <Drafting />;

	if (d.state === "failed")
		return (
			<div className="mb-2 flex items-center gap-2 rounded-xl border border-critical-text/40 bg-critical-surface px-3 py-2 text-sm text-critical-text">
				<Sparkles className="size-4" />
				<span className="min-w-0 flex-1 truncate">{d.error}</span>
				<Button type="button" size="sm" variant="ghost" onClick={redraft}>
					<RefreshCw />
					Draft again
				</Button>
			</div>
		);

	const body = d.body ?? "";
	return (
		<div
			key={d.updatedAt.toString()}
			className={cn(
				"mb-2 rounded-xl border bg-surface px-3 py-2.5 animate-in fade-in-0 slide-in-from-bottom-2",
				d.stale && "opacity-60",
			)}
		>
			<div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
				<Sparkles className="size-3.5 text-primary" />
				{BY[d.by]}
				{d.stale && (
					<span className="text-warning-text">· before their last message</span>
				)}
				<span className="ml-auto flex gap-0.5">
					{ai && (
						<Tip content="Draft again">
							<Button
								type="button"
								size="sm"
								variant="ghost"
								aria-label="Draft again"
								onClick={redraft}
							>
								<RefreshCw />
							</Button>
						</Tip>
					)}
					<Tip content="Into the reply box">
						<Button
							type="button"
							size="sm"
							variant="secondary"
							aria-label="Into the reply box"
							onClick={() => {
								setPulled(version);
								onEdit(body, d.english);
							}}
						>
							<ArrowDown />
						</Button>
					</Tip>
				</span>
			</div>
			<p className="whitespace-pre-wrap">{body}</p>
			{d.english && (
				<p className="mt-1.5 border-l-2 pl-2 text-sm whitespace-pre-wrap text-muted-foreground">
					{d.english}
				</p>
			)}
			{(d.note || d.precedents.length > 0) && (
				<div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
					{d.precedents.map((p) => (
						<span
							key={p.id}
							className="rounded-md bg-surface-strong px-1.5 py-0.5 text-muted-foreground"
						>
							{p.name}
						</span>
					))}
					{d.note && <span className="text-warning-text">{d.note}</span>}
				</div>
			)}
		</div>
	);
}

function Drafting() {
	return (
		<div className="mb-2 flex items-center gap-2 rounded-xl border border-dashed px-3 py-3 text-sm text-muted-foreground">
			<Sparkles className="size-4 animate-pulse" />
			<span className="h-3 flex-1 animate-pulse rounded bg-surface-strong" />
		</div>
	);
}
