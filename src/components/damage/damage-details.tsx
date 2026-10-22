import { Camera, ChevronRight, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Tip } from "#/components/ui/tooltip";
import { formatDay } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import {
	type PurchaseOrderDetail,
	removePurchaseDamage,
	removePurchaseDamagePhoto,
} from "#/server/purchasing";

export type Damage = PurchaseOrderDetail["damages"][number];

export const damageName = (d: Pick<Damage, "name" | "variantName">) =>
	d.variantName ? `${d.name} (${d.variantName})` : d.name;

const photoUrl = (id: number) => `/purchasing/damage-photo/${id}`;

// Whether the supplier has been told, and what was asked for.
function DamageStatus({ damage: x }: { damage: Damage }) {
	return x.reportedAt ? (
		<Badge>
			{x.remedy === "replacement" ? "Replacement" : "Credit"} asked ·{" "}
			{formatDay(x.reportedAt)}
		</Badge>
	) : (
		<Badge tone="warning">Not reported</Badge>
	);
}

// One damage, as a row under the line it came from. `columns` is how many
// the table has, so it spans them all. Clicking opens its details.
export function DamageRow({
	damage: x,
	columns,
	onOpen,
	onContextMenu,
}: {
	damage: Damage;
	columns: number;
	onOpen: () => void;
	onContextMenu: () => void;
}) {
	return (
		<tr onContextMenu={onContextMenu}>
			<td colSpan={columns} className="p-0">
				<button
					type="button"
					onClick={onOpen}
					className="flex w-full cursor-pointer items-center gap-3 bg-critical-surface/40 py-1.5 pr-4 pl-10 text-left hover:bg-critical-surface/70 focus-visible:bg-critical-surface/70 focus-visible:outline-none"
				>
					<div className="flex min-w-0 flex-1 items-center gap-3 border-l-2 border-critical-text/40 pl-3">
						{x.photoIds.length > 0 && (
							<div className="flex shrink-0 gap-1">
								{x.photoIds.slice(0, 3).map((id) => (
									<img
										key={id}
										src={photoUrl(id)}
										alt=""
										className="size-8 rounded-md bg-surface-strong object-cover"
									/>
								))}
								{x.photoIds.length > 3 && (
									<span className="flex size-8 items-center justify-center rounded-md bg-surface-strong text-xs text-muted-foreground">
										+{x.photoIds.length - 3}
									</span>
								)}
							</div>
						)}
						<span className="shrink-0 text-sm font-semibold text-critical-text">
							{x.quantity} {x.kind}
						</span>
						{x.description && (
							<span className="min-w-0 truncate text-sm text-muted-foreground">
								{x.description}
							</span>
						)}
					</div>
					<DamageStatus damage={x} />
					<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
				</button>
			</td>
		</tr>
	);
}

// Everything about one damage: what's wrong, its photos at a size you can
// see, and whether the supplier has been told. Until then it can take more
// photos, lose one, or be removed if it was recorded by mistake.
export function DamageDetailsDialog({
	damage: x,
	onAddPhotos,
	onClose,
}: {
	damage: Damage;
	onAddPhotos: () => void;
	onClose: () => void;
}) {
	const reported = x.reportedAt !== null;
	const single =
		x.packSize === 1 ? "" : ` single ${x.quantity === 1 ? "item" : "items"}`;
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{x.quantity}
						{single} {x.kind}
					</DialogTitle>
					<DialogDescription>
						{damageName(x)} · <span className="font-mono">{x.sku}</span>
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					{x.description && (
						<p className="whitespace-pre-wrap rounded-lg bg-subtle p-3">
							{x.description}
						</p>
					)}

					{x.photoIds.length > 0 ? (
						<div className="flex flex-wrap gap-2">
							{x.photoIds.map((id) => (
								<div key={id} className="relative">
									<a href={photoUrl(id)} target="_blank" rel="noreferrer">
										<img
											src={photoUrl(id)}
											alt="Damage"
											className="size-24 rounded-lg bg-surface-strong object-cover hover:opacity-80"
										/>
									</a>
									{!reported && (
										<button
											type="button"
											aria-label="Delete photo"
											onClick={() => deletePhoto(x, id)}
											className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-foreground text-background shadow-card"
										>
											<X className="size-3.5" />
										</button>
									)}
								</div>
							))}
						</div>
					) : (
						<p className="text-sm text-muted-foreground">No photos.</p>
					)}

					<div className="flex flex-col gap-1 text-sm">
						<p className="text-muted-foreground">
							Recorded {formatDay(x.createdAt)}. Taken off the shelf then.
						</p>
						{x.reportedAt ? (
							<p>
								Reported to {x.reportedTo} on {formatDay(x.reportedAt)}, asking
								for {x.remedy === "replacement" ? "a replacement" : "credit"}.
								It can't change now.
							</p>
						) : (
							<p>
								Not reported yet. Send it with Damage report at the top of this
								PO.
							</p>
						)}
					</div>
				</div>

				<DialogFooter className="gap-2 sm:justify-between">
					{/* Shown once reported too, so it's clear why it can't go. */}
					<Tip
						content={
							reported
								? "Already sent to the supplier, so it stays"
								: "Recorded by mistake? Puts them back on the shelf"
						}
					>
						<Button
							variant="ghost"
							className="text-critical-text"
							disabled={reported}
							onClick={async () => {
								if (await deleteDamage(x)) onClose();
							}}
						>
							<Trash2 />
							Delete damage report
						</Button>
					</Tip>
					<div className="flex gap-2">
						{!reported && (
							<Button variant="outline" onClick={onAddPhotos}>
								<Camera />
								Add photos
							</Button>
						)}
						<Button onClick={onClose}>Done</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// Damage recorded by mistake: deleted, and the items go back on the shelf.
// It always asks, saying what happens, since the photos are deleted for good.
async function deleteDamage(x: Damage) {
	const photos =
		x.photoIds.length === 0
			? ""
			: ` The ${x.photoIds.length === 1 ? "photo is" : `${x.photoIds.length} photos are`} deleted.`;
	if (
		!confirm(
			`Delete this damage report? The ${x.quantity} × ${x.sku} go back on the shelf.${photos}`,
		)
	)
		return false;
	const r = await optimism.change({
		send: () => removePurchaseDamage({ data: { id: x.id } }),
	});
	if (r) toast.success(`${x.quantity} × ${x.sku} back on the shelf`);
	return Boolean(r);
}

// A photo that shouldn't go to the supplier, e.g. too large or the wrong one.
// It's gone for good, so it asks first.
async function deletePhoto(x: Damage, photoId: number) {
	if (!confirm(`Delete this photo of ${x.sku}?`)) return;
	const r = await optimism.change({
		send: () => removePurchaseDamagePhoto({ data: { id: photoId } }),
	});
	if (r) toast.success("Photo deleted");
}
