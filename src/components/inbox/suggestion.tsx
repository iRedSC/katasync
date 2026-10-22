import { useRouter } from "@tanstack/react-router";
import { PenLine, RefreshCw, SendHorizontal, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { BuyerThread } from "#/buyers/threads";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";
import { draftReplyNow } from "#/server/buyer-drafts";

// The reply suggested for a thread, above the reply box: sent as it is in
// one click, or taken into the box to change. Who wrote it shows as a
// chip; the precedents it followed and what to check sit under it.

type Draft = NonNullable<BuyerThread["draft"]>;

const BY: Record<Draft["by"], string> = {
	ai: "Suggested",
	claude: "From Claude",
	staff: "Saved by you",
};

export function Suggestion({
	thread: t,
	ai,
	onSend,
	onEdit,
}: {
	thread: BuyerThread;
	// Without the AI, a suggestion Claude or staff saved still shows, with
	// nothing to draft it again.
	ai: boolean;
	onSend: (body: string, key: string) => void;
	onEdit: (body: string, english: string | null) => void;
}) {
	const router = useRouter();
	const [redrafting, setRedrafting] = useState(false);
	const d = t.draft;
	// One key per version of the suggestion, so it goes once however it's
	// clicked; sent, it leaves at once rather than when the list catches up.
	const version = d?.updatedAt.toString() ?? "";
	const key = useMemo(() => (version ? crypto.randomUUID() : ""), [version]);
	const [sent, setSent] = useState<string | null>(null);
	if (!t.waiting || !d || sent === version) return null;
	// Drafting and failing are the agent's; without it, only a saved one shows.
	if (!ai && d.state !== "ready") return null;

	async function redraft() {
		setRedrafting(true);
		try {
			const d = await draftReplyNow({ data: { threadId: t.id } });
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

	if (d.state === "drafting" || redrafting)
		return (
			<div className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-dashed px-3 py-3 text-sm text-muted-foreground">
				<Sparkles className="size-4 animate-pulse" />
				<span className="h-3 flex-1 animate-pulse rounded bg-surface-strong" />
			</div>
		);

	if (d.state === "failed")
		return (
			<div className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-critical-text/40 bg-critical-surface px-3 py-2 text-sm text-critical-text">
				<Sparkles className="size-4" />
				<span className="min-w-0 flex-1 truncate">{d.error}</span>
				<Button size="sm" variant="ghost" onClick={redraft}>
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
				"mx-3 mt-3 rounded-xl border bg-surface px-3 py-2.5 animate-in fade-in-0 slide-in-from-bottom-2",
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
								size="sm"
								variant="ghost"
								aria-label="Draft again"
								onClick={redraft}
							>
								<RefreshCw />
							</Button>
						</Tip>
					)}
					<Tip content="Change it">
						<Button
							size="sm"
							variant="ghost"
							aria-label="Change it"
							onClick={() => onEdit(body, d.english)}
						>
							<PenLine />
						</Button>
					</Tip>
					<Button
						size="sm"
						onClick={() => {
							setSent(version);
							onSend(body, key);
						}}
					>
						<SendHorizontal />
						Send
					</Button>
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
							{p.when}
						</span>
					))}
					{d.note && <span className="text-warning-text">{d.note}</span>}
				</div>
			)}
		</div>
	);
}
