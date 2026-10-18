import { Camera, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatDay } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import {
	type PurchaseOrderDetail,
	removePurchaseDamage,
} from "#/server/purchasing";

type Damage = PurchaseOrderDetail["damages"][number];

export const damageName = (d: Pick<Damage, "name" | "variantName">) =>
	d.variantName ? `${d.name} (${d.variantName})` : d.name;

// Damage recorded on the PO, each its own row under what was received: how
// many, what's wrong, its photos, and whether the supplier has been told.
// Until then it can take more photos, or be taken back.
export function DamageRows({
	damages,
	onAddPhotos,
}: {
	damages: Damage[];
	onAddPhotos: (damage: Damage) => void;
}) {
	return (
		<ul className="divide-y border-t">
			{damages.map((x) => (
				<li
					key={x.id}
					className="flex items-center gap-4 bg-critical-surface/40 px-4 py-2.5"
				>
					<div className="flex shrink-0 gap-1">
						{x.photoIds.map((id) => (
							<a
								key={id}
								href={`/purchasing/damage-photo/${id}`}
								target="_blank"
								rel="noreferrer"
							>
								<img
									src={`/purchasing/damage-photo/${id}`}
									alt="Damage"
									className="size-10 rounded-md bg-surface-strong object-cover hover:opacity-80"
								/>
							</a>
						))}
					</div>
					<div className="min-w-0 flex-1">
						<p className="text-sm">
							<span className="font-semibold text-critical-text">
								{x.quantity} damaged
							</span>{" "}
							× {damageName(x)}{" "}
							<span className="font-mono text-xs text-muted-foreground">
								{x.sku}
							</span>
						</p>
						<p className="truncate text-sm text-muted-foreground">
							{x.description}
						</p>
					</div>
					{x.reportedAt ? (
						<Badge>
							{x.remedy === "replacement" ? "Replacement" : "Credit"} asked ·{" "}
							{formatDay(x.reportedAt)}
						</Badge>
					) : (
						<>
							<Badge tone="warning">Not reported</Badge>
							<Button size="sm" variant="ghost" onClick={() => onAddPhotos(x)}>
								<Camera />
								Add photos
							</Button>
							<Button size="sm" variant="ghost" onClick={() => takeBack(x)}>
								<Undo2 />
								Take back
							</Button>
						</>
					)}
				</li>
			))}
		</ul>
	);
}

// Damage recorded by mistake: back on the shelf. With photos it asks
// first, since they're deleted and Undo couldn't bring them back.
async function takeBack(x: Damage) {
	if (
		x.photoIds.length > 0 &&
		!confirm(
			`Take back ${x.quantity} damaged × ${x.sku}? They go back on the shelf and the ${x.photoIds.length === 1 ? "photo is" : "photos are"} deleted.`,
		)
	)
		return;
	const r = await optimism.change({
		send: () => removePurchaseDamage({ data: { id: x.id } }),
	});
	if (r) toast.success(`${x.quantity} × ${x.sku} back on the shelf`);
}
