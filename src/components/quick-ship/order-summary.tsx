import { ChannelBadge } from "#/components/channel-badge";
import { PackBlockBadge } from "#/components/pack-block-badge";
import { Badge } from "#/components/page";
import { ProductImage } from "#/components/product";
import { Truncate } from "#/components/truncate";
import { cn } from "#/lib/utils";
import type { ShipmentPlan } from "#/shipping/quick-ship";
import { Key } from "./key";
import type { Found } from "./types";

export function OrderSummary({
	found,
	plan,
	canCombine,
	onToggle,
	onCount,
}: {
	found: Found;
	plan: ShipmentPlan;
	canCombine: boolean;
	onToggle: (id?: number) => void;
	onCount: (orderLineId: number, quantity: number) => void;
}) {
	const o = found.order;
	// Counts are chosen with the box's contents, while choosing the first box.
	const chooses = canCombine && plan.choosable;
	// Units going, by order.
	const going = new Map<number, number>();
	for (const c of plan.choices)
		going.set(c.orderId, (going.get(c.orderId) ?? 0) + c.quantity);
	const combined = plan.orderIds.length > 1;
	// TikTok hides the address, so its orders match on the buyer.
	const toSame =
		found.labelSource === "tiktok" ? "from this buyer" : "to this address";
	return (
		<div className="flex flex-col gap-3 border-b px-6 py-4">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<Truncate
						text={o.customerName ?? "No name"}
						className="text-xl font-semibold"
					/>
					{o.shipCity && (
						<div className="text-muted-foreground">
							{[o.shipCity, o.shipRegion].filter(Boolean).join(", ")}
						</div>
					)}
				</div>
				<div className="flex shrink-0 gap-1.5">
					{found.liveDispatchId !== null && (
						<Badge tone="warning">Already has a label</Badge>
					)}
					{/* Nothing to pack until the marketplace's count is known;
					buying says why too. */}
					{o.packBlock && <PackBlockBadge block={o.packBlock} />}
					<ChannelBadge channel={o.channel} salesChannel={o.salesChannel} />
				</div>
			</div>
			<ul className="flex flex-col gap-2">
				{plan.choices.map((l) => (
					<li
						key={l.orderLineId}
						className={cn(
							"flex items-center gap-3 transition-opacity",
							// Left for a later shipment.
							l.quantity === 0 && "opacity-40",
						)}
					>
						<ProductImage src={l.imageUrl} className="size-12" />
						{chooses ? (
							<UnitCount
								line={l}
								// An order's last unit can't be taken out: untick the
								// order to leave it out of the box.
								canLower={(going.get(l.orderId) ?? 0) > 1}
								onCount={(n) => onCount(l.orderLineId, n)}
							/>
						) : (
							<span className="w-12 shrink-0 text-2xl font-bold tabular-nums">
								{l.quantity}×
							</span>
						)}
						<Truncate
							text={l.title}
							className={cn(
								"flex-1 text-base",
								l.quantity === 0 && "line-through",
							)}
						/>
						{combined && (
							<span className="shrink-0 text-muted-foreground">
								{plan.orderNames[plan.orderIds.indexOf(l.orderId)]}
							</span>
						)}
					</li>
				))}
			</ul>
			{found.companions.length > 0 && (
				<div className="flex flex-col gap-2 rounded-xl border-2 border-info-border bg-info-surface px-4 py-3 text-info-text">
					<p className="text-lg font-semibold">
						{found.companions.length === 1
							? `Another order ${toSame}`
							: `${found.companions.length} more orders ${toSame}`}
						{canCombine && (
							<span className="font-normal">
								{" "}
								· <Key>Tab</Key> combines
							</span>
						)}
					</p>
					<ul className="flex flex-col gap-1">
						{found.companions.map((c) => {
							const included = plan.orderIds.includes(c.id);
							return (
								<li key={c.id}>
									<label className="flex items-center gap-3 text-base">
										<input
											type="checkbox"
											className="size-5"
											checked={included}
											disabled={!canCombine}
											onChange={() => onToggle(c.id)}
										/>
										<span className="font-semibold">{c.name}</span>
										{c.pin !== null && <span>pin {c.pin}</span>}
										<span>
											· {c.customerName ?? "No name"} · {c.items}{" "}
											{c.items === 1 ? "item" : "items"}
										</span>
									</label>
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</div>
	);
}

// How many of a line go in this box, from 0 to all that's packable. When
// fewer, the rest shows beside it: it stays on To ship.
function UnitCount({
	line,
	canLower,
	onCount,
}: {
	line: ShipmentPlan["choices"][number];
	canLower: boolean;
	onCount: (quantity: number) => void;
}) {
	const step =
		"size-7 shrink-0 rounded-md border text-lg leading-none hover:bg-muted disabled:opacity-30";
	// Clicked, never focused: Enter keeps finishing the box step instead of
	// pressing the button again.
	const keepFocus = {
		tabIndex: -1,
		onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
	};
	return (
		<span className="flex shrink-0 items-center gap-1">
			<button
				type="button"
				{...keepFocus}
				className={step}
				aria-label={`Send one fewer ${line.title}`}
				disabled={line.quantity === 0 || !canLower}
				onClick={() => onCount(line.quantity - 1)}
			>
				−
			</button>
			<span className="w-8 text-center text-2xl font-bold tabular-nums">
				{line.quantity}
			</span>
			<button
				type="button"
				{...keepFocus}
				className={step}
				aria-label={`Send one more ${line.title}`}
				disabled={line.quantity === line.packable}
				onClick={() => onCount(line.quantity + 1)}
			>
				+
			</button>
			<span
				className={cn(
					"w-14 text-muted-foreground tabular-nums",
					line.quantity === line.packable && "invisible",
				)}
			>
				of {line.packable}
			</span>
		</span>
	);
}
