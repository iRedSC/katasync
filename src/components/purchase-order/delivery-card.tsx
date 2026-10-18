import { Card } from "#/components/page";
import { cityLine } from "#/lib/format";
import { editDraft, type PurchaseOrderDetail } from "#/server/purchasing";
import { Dates } from "./dates";
import { isUnsent, poData } from "./po-data";
import { useAction } from "./use-action";

export function DeliveryCard({ detail: d }: { detail: PurchaseOrderDetail }) {
	const po = d.order;
	const draft = isUnsent(po.status);
	const { save } = useAction();
	return (
		<Card title="Delivery">
			<div className="flex flex-col gap-2">
				{draft && d.locations.length > 1 ? (
					<select
						value={po.locationId}
						onChange={(e) => {
							const locationId = Number(e.target.value);
							save({
								label: "Delivery location",
								patch: poData.patch(po.id, (data) => ({
									...data,
									order: { ...data.order, locationId },
								})),
								send: () =>
									editDraft({
										data: { purchaseOrderId: po.id, locationId },
									}),
							});
						}}
						className="h-8 rounded-lg border border-input px-2"
					>
						{d.locations.map((l) => (
							<option key={l.id} value={l.id}>
								{l.name}
							</option>
						))}
					</select>
				) : (
					<div>
						<div className="font-medium">{d.location.name}</div>
						<div className="text-muted-foreground">
							{cityLine(
								d.location.city,
								d.location.region,
								d.location.postalCode,
							)}
						</div>
					</div>
				)}
				<Dates detail={d} />
			</div>
		</Card>
	);
}
