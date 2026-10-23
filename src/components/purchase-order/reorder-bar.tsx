import { Lock, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import { wantsMore } from "#/purchasing/changes";
import {
	type PurchaseOrderDetail,
	updateDraftFromSuggestions,
} from "#/server/purchasing";
import { describe, SuggestionsDialog } from "./suggestions-dialog";
import { useAction } from "./use-action";

// Above an unsent PO's lines: how its suggestion stands, the settings it's
// worked out with, Suggestions to change them, and refresh to bring the
// suggestion in again. A suggested PO is today's suggestion until its first
// change. A draft doesn't change by itself; when its suggestion has moved
// on, the bar says how and refresh brings it in: new products added, short
// quantities raised, nothing lowered.
export function ReorderBar({ detail: d }: { detail: PurchaseOrderDetail }) {
	const { busy, run } = useAction();
	const [open, setOpen] = useState(false);
	const suggested = d.order.status === "suggested";
	const { added } = d.changes;
	// Worked out here, so a lock or a new quantity shows at once.
	const short = d.lines.filter(wantsMore);
	const raised = short.filter((l) => !l.locked).length;
	const skipped = short.length - raised;
	const behind = !suggested && added + raised > 0;

	const refresh = () =>
		run(
			() => updateDraftFromSuggestions({ data: { id: d.order.id } }),
			(r) =>
				suggested
					? "Suggestion refreshed"
					: (describe({ ...r, lowered: 0, removed: 0 }) ??
						"Already up to date"),
		);

	return (
		<div
			className={cn(
				"flex items-center gap-3 border-b px-4 py-2 transition-colors",
				(behind || suggested) && "bg-info-surface",
			)}
		>
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
				<p className={cn(!behind && !suggested && "text-muted-foreground")}>
					{suggested ? (
						"Today's suggestion. Becomes a draft on your first change."
					) : behind ? (
						<span className="font-medium">
							{[
								added > 0 && `${formatCount(added)} new`,
								raised > 0 &&
									`${formatCount(raised)} ${raised === 1 ? "needs" : "need"} more`,
							]
								.filter(Boolean)
								.join(", ")}
						</span>
					) : (
						"Up to date"
					)}
				</p>
				{skipped > 0 && (
					<Tip content="Locked lines refresh leaves alone">
						<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
							<Lock aria-hidden className="size-3" />
							{formatCount(skipped)} skipped
						</span>
					</Tip>
				)}
				<SettingChips detail={d} onOpen={() => setOpen(true)} />
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
					<SlidersHorizontal />
					Suggestions
				</Button>
				<Tip content={suggested ? "Refresh" : "Add new and raise short lines"}>
					<Button
						size="icon-sm"
						variant={behind ? "default" : "ghost"}
						aria-label="Refresh suggestions"
						disabled={busy}
						onClick={refresh}
					>
						<RefreshCw className={cn(busy && "animate-spin")} />
					</Button>
				</Tip>
			</div>
			<SuggestionsDialog detail={d} open={open} onOpenChange={setOpen} />
		</div>
	);
}

// Settings that differ from the supplier's defaults, as chips that open the
// dialog, so a PO worked out differently shows it without opening anything.
function SettingChips({
	detail: d,
	onOpen,
}: {
	detail: PurchaseOrderDetail;
	onOpen: () => void;
}) {
	const { settings, catalogs } = d.suggestion;
	const left = catalogs.filter((c) => settings.excludedCatalogs.includes(c.id));
	const chips = [
		settings.coverDays !== null && `${settings.coverDays} days`,
		left.length > 0 &&
			`${catalogs.length - left.length} of ${catalogs.length} catalogs`,
		settings.includePricier && "Cheaper elsewhere too",
	].filter((c): c is string => typeof c === "string");
	return chips.map((c) => (
		<button
			key={c}
			type="button"
			onClick={onOpen}
			className="rounded-md bg-white/70 px-1.5 text-xs font-medium ring-1 ring-border hover:ring-ring"
		>
			{c}
		</button>
	));
}
