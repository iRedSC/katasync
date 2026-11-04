import { ExternalLink, Send } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/page";
import { shake } from "#/components/shake";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import {
	carrierOf,
	DROP_SHIP_CARRIERS,
	type DropShipCarrier,
	dropShipTarget,
} from "#/orders/drop-ship";
import {
	markOrderDropShip,
	sendOrderDropShipTracking,
	unmarkOrderDropShip,
} from "#/server/drop-ship";

type Named = { id: number; name: string };

// A supplier ships it: its stock goes back on the shelf and it waits on To
// ship for their tracking. Undo puts it back to be packed.
export async function dropShip(order: Named) {
	const r = await optimism.change({
		send: () => markOrderDropShip({ data: { orderId: order.id } }),
	});
	if (!r) return;
	offerUndo(`${order.name} is a drop-ship`, {
		description: "Its stock is back on the shelf",
		undo: async () => {
			const back = await optimism.change({
				send: () => unmarkOrderDropShip({ data: { orderId: order.id } }),
			});
			return back && `${order.name} is back to pack`;
		},
	});
}

// Back to being packed here, taking its stock again.
export async function packHere(order: Named) {
	const r = await optimism.change({
		send: () => unmarkOrderDropShip({ data: { orderId: order.id } }),
	});
	if (!r) return;
	if (r.value.problems.length > 0) toast.error(r.value.problems.join("; "));
	offerUndo(`${order.name} is back to pack`, {
		undo: async () => {
			const again = await optimism.change({
				send: () => markOrderDropShip({ data: { orderId: order.id } }),
			});
			return again && `${order.name} is a drop-ship again`;
		},
	});
}

// The marketplace is told it shipped with no tracking. It can't be taken
// back, but costs nothing worse than an email, so it asks nothing first.
export async function shippedWithoutTracking(order: Named) {
	const r = await optimism.change({
		send: () =>
			sendOrderDropShipTracking({
				data: { orderId: order.id, tracking: null },
			}),
	});
	if (r) toast.success(r.value.message);
}

type TargetOrder = Named & {
	channel: string;
	salesChannel: string | null;
	shipCountry: string | null;
	marketplaceOrderId: string | null;
	externalId: string;
};

const fieldClass =
	"h-8 min-w-0 rounded-md border border-input bg-white px-2 text-sm outline-none focus:border-ring";

// Where a waiting drop-ship's tracking goes in: pasted here for Shopify and
// eBay, which katasync tells itself; a link to the marketplace's own page
// otherwise. The carrier fills in from the number's shape; one that doesn't
// give it away (DHL) is picked.
export function DropShipTracking({
	order,
	className,
}: {
	order: TargetOrder;
	className?: string;
}) {
	const target = dropShipTarget(order);
	const form = useRef<HTMLFormElement>(null);
	const picker = useRef<HTMLSelectElement>(null);
	const [number, setNumber] = useState("");
	const [picked, setPicked] = useState<DropShipCarrier | null>(null);
	const [busy, setBusy] = useState(false);
	const guessed = carrierOf(number);
	const carrier = picked ?? guessed;

	if (target.kind === "elsewhere") {
		return target.url ? (
			<a
				href={target.url}
				target="_blank"
				rel="noreferrer"
				onClick={(e) => e.stopPropagation()}
				className={cn("shrink-0 rounded-md hover:opacity-80", className)}
			>
				<Badge tone="info">
					Add tracking on {target.name}
					<ExternalLink className="ml-1 size-3" />
				</Badge>
			</a>
		) : (
			<Badge tone="info">Add tracking on {target.name}</Badge>
		);
	}

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (busy) return;
		if (number.trim() === "") return shake(form.current);
		if (!carrier) {
			picker.current?.focus();
			return shake(picker.current);
		}
		setBusy(true);
		const r = await optimism.change({
			send: () =>
				sendOrderDropShipTracking({
					data: { orderId: order.id, tracking: { carrier, number } },
				}),
		});
		setBusy(false);
		if (r) toast.success(r.value.message);
	}

	return (
		// Inside a row that opens the order: typing here mustn't.
		<form
			ref={form}
			onSubmit={submit}
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => e.stopPropagation()}
			className={cn("flex items-center gap-1", className)}
		>
			<input
				aria-label={`Supplier tracking for ${order.name}`}
				placeholder="Supplier tracking"
				value={number}
				disabled={busy}
				onChange={(e) => setNumber(e.target.value)}
				className={cn(fieldClass, "w-44 font-mono")}
			/>
			{number.trim() !== "" && (
				<select
					ref={picker}
					aria-label="Carrier"
					value={carrier ?? ""}
					disabled={busy}
					onChange={(e) =>
						setPicked((e.target.value || null) as DropShipCarrier | null)
					}
					className={cn(fieldClass, !carrier && "border-critical-text")}
				>
					{!carrier && <option value="">Carrier?</option>}
					{DROP_SHIP_CARRIERS.map((c) => (
						<option key={c} value={c}>
							{c}
						</option>
					))}
				</select>
			)}
			<button
				type="submit"
				aria-label={`Send tracking to ${target.name}`}
				disabled={busy}
				className={cn(
					"grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground",
					busy && "animate-pulse",
				)}
			>
				<Send className="size-4" />
			</button>
		</form>
	);
}
