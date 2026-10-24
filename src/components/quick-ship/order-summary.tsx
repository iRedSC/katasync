import { ExternalLink } from "lucide-react";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge } from "#/components/page";
import { ProductImage } from "#/components/product";
import { Truncate } from "#/components/truncate";
import { adminUrls } from "#/orders/admin-urls";
import type { ShipmentPlan } from "#/shipping/quick-ship";
import { Key } from "./key";
import type { Found } from "./types";

export function OrderSummary({
	found,
	plan,
	canCombine,
	onToggle,
}: {
	found: Found;
	plan: ShipmentPlan;
	canCombine: boolean;
	onToggle: (id?: number) => void;
}) {
	const o = found.order;
	const combined = plan.orderIds.length > 1;
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
					<ChannelBadge channel={o.channel} salesChannel={o.salesChannel} />
				</div>
			</div>
			<ul className="flex flex-col gap-2">
				{plan.lines.map((l, i) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: lines never reorder within a plan
						key={i}
						className="flex items-center gap-3"
					>
						<ProductImage src={l.imageUrl} className="size-12" />
						<span className="w-12 shrink-0 text-2xl font-bold tabular-nums">
							{l.quantity}×
						</span>
						<Truncate text={l.title} className="flex-1 text-base" />
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
							? "Another order to this address"
							: `${found.companions.length} more orders to this address`}
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
			{found.sameBuyer.length > 0 && (
				<SameBuyerNotice order={o} others={found.sameBuyer} />
			)}
		</div>
	);
}

// TikTok won't combine US orders for an app, so the buyer's other orders are
// combined in Seller Center, which then sells the one label.
function SameBuyerNotice({
	order,
	others,
}: {
	order: Found["order"];
	others: Found["sameBuyer"];
}) {
	const tiktok = adminUrls(order).find((p) => p.channel === "tiktok");
	return (
		<div className="flex flex-col gap-2 rounded-xl border-2 border-warning-border bg-warning-surface px-4 py-3 text-warning-text">
			<div className="flex items-center justify-between gap-3">
				<p className="text-lg font-semibold">Same buyer · combine in TikTok</p>
				{tiktok && (
					<a
						href={tiktok.url}
						target="_blank"
						rel="noreferrer"
						className="inline-flex shrink-0 items-center gap-1 font-semibold hover:underline"
					>
						Open in TikTok
						<ExternalLink className="size-4" />
					</a>
				)}
			</div>
			<ul className="flex flex-col gap-1 text-base">
				{others.map((c) => (
					<li key={c.id}>
						<span className="font-semibold">{c.name}</span>
						{c.pin !== null && <span> · pin {c.pin}</span>}
					</li>
				))}
			</ul>
		</div>
	);
}
