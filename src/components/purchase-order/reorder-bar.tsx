import { Lock } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import { wantsMore } from "#/purchasing/changes";
import {
	type PurchaseOrderDetail,
	updateDraftFromSuggestions,
} from "#/server/purchasing";
import { useAction } from "./use-action";

// A suggested PO isn't saved as anything yet: it shows today's suggestion
// and becomes a draft with the first change.
export function SuggestedBar() {
	return (
		<div className="border-b bg-subtle px-4 py-2.5 text-sm text-muted-foreground">
			Today's suggestion. Becomes a draft on your first change.
		</div>
	);
}

// A draft doesn't change by itself after it's made. When today's
// suggestions have moved on, this says how, and Update brings them in: new
// products added, short quantities raised. Nothing is lowered. The bar keeps
// its height when up to date so the lines below don't shift.
export function FrozenBar({ detail: d }: { detail: PurchaseOrderDetail }) {
	const { busy, run } = useAction();
	const { added } = d.changes;
	// Worked out here, so a lock or a new quantity shows at once.
	const short = d.lines.filter(wantsMore);
	const raised = short.filter((l) => !l.locked).length;
	const skipped = short.length - raised;
	const skippedNote = skipped > 0 && (
		<Tip content="Locked lines Update leaves alone">
			<span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
				<Lock aria-hidden className="size-3" />
				{formatCount(skipped)} skipped
			</span>
		</Tip>
	);
	if (added + raised === 0)
		return (
			<div className="flex items-center gap-3 border-b px-4 py-2.5">
				<p className="min-w-0 flex-1 text-muted-foreground">
					Up to date{skippedNote}
				</p>
				<div aria-hidden className="h-8" />
			</div>
		);
	const parts = [
		added > 0 && `${formatCount(added)} new`,
		raised > 0 &&
			`${formatCount(raised)} ${raised === 1 ? "needs" : "need"} more`,
	].filter(Boolean);
	return (
		<div className="flex items-center gap-3 border-b bg-info-surface px-4 py-2.5">
			<p className="min-w-0 flex-1">
				<span className="font-medium">
					Reorder needs changed: {parts.join(", ")}.
				</span>
				{skippedNote}
			</p>
			<Button
				size="sm"
				variant="outline"
				disabled={busy}
				onClick={() =>
					run(
						() => updateDraftFromSuggestions({ data: { id: d.order.id } }),
						(r) =>
							r.added + r.raised === 0
								? "Already up to date"
								: [
										r.added > 0 && `added ${r.added}`,
										r.raised > 0 && `raised ${r.raised}`,
									]
										.filter(Boolean)
										.join(" and ")
										.replace(/^./, (c) => c.toUpperCase()),
					)
				}
			>
				Update
			</Button>
		</div>
	);
}
