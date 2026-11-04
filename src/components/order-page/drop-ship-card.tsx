import {
	DropShipTracking,
	shippedWithoutTracking,
} from "#/components/drop-ship";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { dropShipTarget } from "#/orders/drop-ship";
import { orderStatus } from "#/orders/status";
import type { OrderDetail } from "#/server/orders";

// A drop-ship's side of the order: the supplier's tracking to send while it
// waits, and what went to the marketplace once it did.
export function DropShipCard({ order }: { order: OrderDetail["order"] }) {
	const target = dropShipTarget(order);
	const waiting = orderStatus(order).key === "dropship";
	return (
		<Card title="Drop-ship">
			{order.dropShipSentAt ? (
				<p>
					Sent to {target.name}
					{order.dropShipTracking ? (
						<>
							{" "}
							with {order.dropShipCarrier}{" "}
							<span className="font-mono">{order.dropShipTracking}</span>
						</>
					) : (
						" without tracking"
					)}
				</p>
			) : waiting ? (
				<div className="flex flex-col items-start gap-2">
					<DropShipTracking order={order} />
					{target.kind === "tell" && (
						<Button
							size="sm"
							variant="ghost"
							className="-ml-2 text-muted-foreground"
							onClick={() => shippedWithoutTracking(order)}
						>
							Shipped, no tracking
						</Button>
					)}
				</div>
			) : (
				<p className="text-muted-foreground">Shipped by the supplier</p>
			)}
		</Card>
	);
}
