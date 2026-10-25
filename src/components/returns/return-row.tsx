import { Ban } from "lucide-react";
import { ChannelBadge } from "#/components/channel-badge";
import { OrderProducts } from "#/components/orders-list/order-products";
import { PackageWhere } from "#/components/package-status";
import { Badge, type Tone } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import type { ReturnState } from "#/db/schema";
import { formatCount, formatOrderDate } from "#/lib/format";
import type { useRowLink } from "#/lib/row-link";
import { returnReason } from "#/orders/return-reasons";
import type { ReturnOrder } from "#/orders/returns-due";

export const states: Record<
	ReturnState,
	{ label: string; tone?: Tone; heading: string }
> = {
	on_its_way: { label: "On its way", tone: "info", heading: "On its way" },
	requested: {
		label: "Requested",
		tone: "info",
		heading: "Requested, not sent yet",
	},
	refunded: {
		label: "Refunded, not back",
		tone: "warning",
		heading: "Refunded, not back yet",
	},
	maybe: { label: "Maybe", heading: "Refunded in part, maybe coming back" },
};

export const ICON_BUTTON =
	"inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-strong hover:text-foreground";

// One order with something coming back, laid out as the orders list lays
// out an order. A click opens the order, where its whole return is; its
// Receive opens the box.
export function ReturnRow({
	order: o,
	onReceive,
	onNothing,
	link,
}: {
	order: ReturnOrder;
	onReceive: () => void;
	onNothing?: () => void;
	link: ReturnType<typeof useRowLink>["link"];
}) {
	const state = o.state ? states[o.state] : null;
	const request = o.requests[0];
	const expected = o.lines.filter((l) => l.expected > 0);
	const coming = (expected.length > 0 ? expected : o.lines).map((l) => ({
		id: l.id,
		title: l.title,
		sku: l.sku,
		quantity: l.expected || l.left,
		productSku: null,
		productName: null,
		imageUrl: l.imageUrl,
		fromStore: [],
	}));
	return (
		<tr
			{...link({ to: "/orders/$id", params: { id: String(o.id) } })}
			className="cursor-pointer border-t first:border-t-0 hover:bg-subtle"
		>
			<td className="px-4 py-2.5 font-semibold">{o.name}</td>
			<td className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">
				{formatOrderDate(o.placedAt)}
			</td>
			<td className="w-2/5 max-w-0 px-4 py-2.5">
				<div className="truncate">{o.customerName ?? "No name"}</div>
				<div className="truncate text-xs text-muted-foreground">
					{[o.shipCity, o.shipRegion].filter(Boolean).join(", ")}
					{o.shipPostalCode && ` ${o.shipPostalCode}`}
				</div>
			</td>
			<td className="hidden w-3/5 max-w-0 px-4 py-2 md:table-cell">
				<OrderProducts lines={coming} />
			</td>
			<td className="hidden max-w-56 px-4 py-2.5 lg:table-cell">
				{request?.reason && (
					<div className="truncate text-muted-foreground">
						{returnReason(request.reason)}
					</div>
				)}
				{request?.tracking ? (
					<div className="truncate text-xs">
						<PackageWhere t={request.tracking} />
					</div>
				) : (
					request?.trackingNumber && (
						<div className="truncate font-mono text-xs text-muted-foreground">
							{request.carrier && `${request.carrier} `}
							{request.trackingNumber}
						</div>
					)
				)}
				{o.unmatched.map((u, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: two requests can name the same SKU
						key={i}
						className="truncate text-xs text-warning-text"
					>
						{formatCount(u.quantity)} × {u.sku ?? "an item"}, line unclear
					</div>
				))}
			</td>
			<td className="hidden px-4 py-2.5 lg:table-cell">
				<ChannelBadge channel={o.channel} salesChannel={o.salesChannel} />
			</td>
			<td className="px-4 py-2.5">
				<div className="flex gap-1.5">
					{state ? (
						<Badge tone={state.tone}>{state.label}</Badge>
					) : (
						<Badge>Not expected</Badge>
					)}
					{o.blocker && (
						<Tip content={o.blocker}>
							<span>
								<Badge tone="warning">Can't receive here</Badge>
							</span>
						</Tip>
					)}
				</div>
			</td>
			<td className="py-1.5 pr-2">
				<div className="flex items-center justify-end gap-1">
					{!o.blocker && (
						<Button size="sm" variant="outline" onClick={onReceive}>
							Receive
						</Button>
					)}
					{onNothing ? (
						<Tip content="Nothing coming back">
							<button
								type="button"
								aria-label="Nothing coming back"
								onClick={onNothing}
								className={ICON_BUTTON}
							>
								<Ban className="size-4" />
							</button>
						</Tip>
					) : (
						<span className="size-7" />
					)}
				</div>
			</td>
		</tr>
	);
}
