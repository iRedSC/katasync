import { Link } from "@tanstack/react-router";
import { ChannelBadge } from "#/components/channel-badge";
import { ProductImage, ProductName } from "#/components/product";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatMoney, formatOrderDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import { Cost } from "./cost-cell";
import { Gauge } from "./gauge";
import { type Item, margin, other, percent, shipping } from "./item";
import { unsure } from "./unsure";
import { VERDICT, verdict } from "./verdict";

export function Row({ item: i, range }: { item: Item; range: string }) {
	const notes = unsure(i);
	const m = margin(i);
	const v = verdict(i);
	// Without a cost the figure is too high, so it's muted.
	const tone = !i.costKnown ? "text-muted-foreground" : v && VERDICT[v].text;
	return (
		<tr
			className={cn(
				"border-t first:border-t-0",
				v ? cn(VERDICT[v].row, "hover:brightness-[0.97]") : "hover:bg-subtle",
			)}
		>
			<td className="px-2.5 py-2">
				<div className="flex items-center gap-2">
					<ChannelBadge channel={i.soldOn} salesChannel={null} compact />
					<Link
						to="/orders/$id"
						params={{ id: String(i.orderId) }}
						className="font-medium text-link hover:underline"
					>
						{i.orderName}
					</Link>
				</div>
				<div className="mt-0.5 text-xs text-muted-foreground">
					{formatOrderDate(i.placedAt)}
				</div>
			</td>
			{/* Takes the leftover width; long names end in "…". */}
			<td className="max-w-0 min-w-52 px-2.5 py-2">
				<div className="flex items-center gap-2.5">
					<ProductImage src={i.imageUrl} className="size-8" />
					<div className="min-w-0">
						{i.productId !== null && i.sku ? (
							<Link
								to="/products/$sku"
								params={{ sku: i.sku }}
								className="block truncate hover:underline"
							>
								<ProductName name={i.name} variantName={i.variantName} />
							</Link>
						) : (
							<div className="truncate">{i.name}</div>
						)}
						<div className="truncate text-xs text-muted-foreground">
							{i.sku ?? "No SKU"} · {formatCount(i.quantity)} sold
						</div>
					</div>
				</div>
			</td>
			<td className="px-2.5 py-2 text-right">{formatMoney(i.revenue)}</td>
			<td className="px-2.5 py-2 text-right">
				<Cost item={i} range={range} />
			</td>
			<td className="px-2.5 py-2 text-right">
				{formatMoney(i.fees)}
				{i.feesStatus === "estimated" && <Approx />}
			</td>
			<td className="px-2.5 py-2 text-right">
				<Tip
					content={`Labels ${formatMoney(i.labels)}, less ${formatMoney(i.shippingCharged)} the buyer paid for shipping`}
				>
					<span>{formatMoney(shipping(i))}</span>
				</Tip>
			</td>
			<td className="px-2.5 py-2 text-right">
				{other(i) === 0 ? (
					<span className="text-muted-foreground">—</span>
				) : (
					<Tip
						content={`Refunds ${formatMoney(i.refunds)}, other adjustments ${formatMoney(i.adjustments)}`}
					>
						<span>{formatMoney(other(i))}</span>
					</Tip>
				)}
			</td>
			<td className={cn("px-2.5 py-2 text-right", tone)}>
				<span className="font-semibold">{formatMoney(i.profit)}</span>
				{notes.length > 0 && (
					<Tip
						content={
							<ul className="list-disc pl-4">
								{notes.map((n) => (
									<li key={n}>{n}</li>
								))}
							</ul>
						}
					>
						<span className="ml-1 text-warning-text">≈</span>
					</Tip>
				)}
				<div className="text-xs">{percent(m)}</div>
			</td>
			<td className="py-2 pr-4 pl-1.5">
				<Gauge profit={i.profit} unsure={!i.costKnown} />
			</td>
		</tr>
	);
}

function Approx() {
	return (
		<Tip content="An estimate until the marketplace reports it">
			<span className="ml-1 text-warning-text">≈</span>
		</Tip>
	);
}
