import { Lock } from "lucide-react";
import { Slider, Switch } from "radix-ui";
import { useEffect, useState } from "react";
import { CatalogChips } from "#/components/catalog-picker";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import {
	applySuggestionSettings,
	type PurchaseOrderDetail,
	previewSuggestionSettings,
	undoSuggestionSettings,
} from "#/server/purchasing";

type Settings = PurchaseOrderDetail["suggestion"]["settings"];
type Preview = Awaited<ReturnType<typeof previewSuggestionSettings>>;

const MIN_DAYS = 7;
const MAX_DAYS = 180;

// What a PO's suggestions are worked out with: how many days of sales to
// cover, which of the supplier's catalogs, and whether to take items another
// supplier sells for less. What applying would do shows as it's changed, so
// the counts are the feedback; applying makes the draft match, with Undo.
export function SuggestionsDialog({
	detail: d,
	open,
	onOpenChange,
}: {
	detail: PurchaseOrderDetail;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const saved = d.suggestion.settings;
	const [draft, setDraft] = useState<Settings>(saved);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [busy, setBusy] = useState(false);
	// Starts from what's saved each time it opens.
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) {
			setDraft(saved);
			setPreview(null);
		}
	}

	const days = draft.coverDays ?? d.supplier.coverDays;
	const catalogs = d.suggestion.catalogs;
	const included = catalogs
		.map((c) => c.id)
		.filter((id) => !draft.excludedCatalogs.includes(id));
	const locked = d.lines.filter((l) => l.locked).length;

	// Asked a moment after the last change, so dragging the slider doesn't
	// ask for every day it passes. A stale answer never lands over a newer.
	useEffect(() => {
		if (!open) return;
		let current = true;
		const timer = setTimeout(() => {
			previewSuggestionSettings({ data: { id: d.order.id, settings: draft } })
				.then((p) => current && setPreview(p))
				.catch(() => current && setPreview(null));
		}, 250);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [open, draft, d.order.id]);

	async function apply() {
		setBusy(true);
		const r = await optimism.change({
			send: () =>
				applySuggestionSettings({ data: { id: d.order.id, settings: draft } }),
		});
		setBusy(false);
		if (!r) return;
		onOpenChange(false);
		const { undo, ...changed } = r.value;
		offerUndo(describe(changed) ?? "Settings saved; lines already match", {
			tone: "success",
			undo: async () => {
				const u = await optimism.change({
					send: () =>
						undoSuggestionSettings({ data: { id: d.order.id, undo } }),
				});
				if (!u) return null;
				// Lines changed since keep the change; say so, since the undo
				// looks partial otherwise.
				return u.value.kept > 0
					? `Undone, but ${u.value.kept} ${u.value.kept === 1 ? "line" : "lines"} changed since kept their change`
					: "Undone";
			},
		});
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Reorder for PO {d.order.id}</DialogTitle>
				</DialogHeader>

				<section className="flex flex-col gap-2">
					<div className="flex items-baseline justify-between">
						<span className="font-medium">Cover</span>
						<span className="tabular-nums">
							<span className="text-lg font-semibold">{days}</span> days
							{draft.coverDays !== null &&
								draft.coverDays !== d.supplier.coverDays && (
									<button
										type="button"
										onClick={() => setDraft({ ...draft, coverDays: null })}
										className="ml-2 text-xs text-link hover:underline"
									>
										{d.supplier.name}'s {d.supplier.coverDays}
									</button>
								)}
						</span>
					</div>
					<Slider.Root
						value={[days]}
						min={MIN_DAYS}
						max={Math.max(MAX_DAYS, days)}
						step={1}
						onValueChange={([v]) =>
							setDraft({
								...draft,
								coverDays: v === d.supplier.coverDays ? null : v,
							})
						}
						aria-label="Days of sales to cover"
						className="relative flex h-5 touch-none items-center select-none"
					>
						<Slider.Track className="relative h-1.5 grow rounded-full bg-surface-strong">
							<Slider.Range className="absolute h-full rounded-full bg-primary" />
						</Slider.Track>
						<Slider.Thumb className="block size-4 rounded-full border-2 border-primary bg-white shadow outline-none focus-visible:ring-2 focus-visible:ring-ring" />
					</Slider.Root>
				</section>

				{catalogs.length > 1 && (
					<section className="flex flex-col gap-2">
						<span className="font-medium">Catalogs</span>
						<CatalogChips
							value={included}
							catalogs={catalogs}
							onChange={(ids) =>
								setDraft({
									...draft,
									excludedCatalogs: catalogs
										.map((c) => c.id)
										.filter((id) => !ids.includes(id)),
								})
							}
						/>
					</section>
				)}

				<div className="flex items-center justify-between gap-3">
					<label
						htmlFor="include-pricier"
						className="cursor-pointer font-medium"
					>
						Include items cheaper elsewhere
					</label>
					<Switch.Root
						id="include-pricier"
						checked={draft.includePricier}
						onCheckedChange={(includePricier) =>
							setDraft({ ...draft, includePricier })
						}
						className="relative h-5 w-9 shrink-0 rounded-full bg-surface-strong transition-colors data-[state=checked]:bg-primary"
					>
						<Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
					</Switch.Root>
				</div>

				<PreviewLine preview={preview} locked={locked} />

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button disabled={busy} onClick={apply}>
						Apply
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// What applying would do, as colored counts. Dims while a newer answer is
// on its way rather than blanking, so it doesn't flicker as the slider moves.
function PreviewLine({
	preview,
	locked,
}: {
	preview: Preview | null;
	locked: number;
}) {
	const parts = preview
		? (
				[
					["added", "new", "text-success-text"],
					["raised", "more", "text-success-text"],
					["lowered", "fewer", "text-warning-text"],
					["removed", "off", "text-critical-text"],
				] as const
			).filter(([key]) => preview[key] > 0)
		: [];
	return (
		<div
			className={cn(
				"flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-subtle px-3 py-2 transition-opacity",
				preview === null && "opacity-50",
			)}
		>
			{preview === null ? (
				<span className="text-muted-foreground">…</span>
			) : parts.length === 0 ? (
				<span className="text-muted-foreground">Lines already match</span>
			) : (
				parts.map(([key, word, color]) => (
					<span key={key} className={cn("font-medium tabular-nums", color)}>
						{formatCount(preview[key])} {word}
					</span>
				))
			)}
			{locked > 0 && (
				<span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
					<Lock aria-hidden className="size-3" />
					{formatCount(locked)} stay
				</span>
			)}
		</div>
	);
}

// "Added 3, raised 2, took 1 off", or null when nothing changed.
export function describe(c: {
	added: number;
	raised: number;
	lowered: number;
	removed: number;
}) {
	const parts = [
		c.added > 0 && `added ${c.added}`,
		c.raised > 0 && `raised ${c.raised}`,
		c.lowered > 0 && `lowered ${c.lowered}`,
		c.removed > 0 && `took ${c.removed} off`,
	].filter(Boolean);
	if (parts.length === 0) return null;
	const text = parts.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}
