import { Link } from "@tanstack/react-router";
import { ExternalLink, Tag } from "lucide-react";
import { useEffect, useState } from "react";
import type { BuyerOrder as Order } from "#/buyers/order";
import { OrderStatusBadge } from "#/components/order-status";
import { ReadMark } from "#/components/package-read";
import { PackageStatus } from "#/components/package-status";
import { ProductImage } from "#/components/product";
import { Tip } from "#/components/ui/tooltip";
import type { MailOrders as Found } from "#/inbox/mail-orders";
import { formatCount, formatDay } from "#/lib/format";
import { cn } from "#/lib/utils";
import { knownOf } from "#/orders/tracking-read";
import { getBuyerOrder } from "#/server/buyers";
import { getMailOrders } from "#/server/inbox";

// Under the buyer's name, and above a marketplace email: what they ordered,
// as on the orders list, and each package as the carrier tells it now.
// Asked as the thread or email opens; until then, the order number it
// already knows.

type Package = Order["packages"][number];

export function BuyerOrder({
	threadId,
	orderId,
	fallback,
}: {
	threadId: number;
	// The order the conversation was opened from, when not the thread's own.
	orderId?: number;
	// What shows until the order is read, and when katasync doesn't have it.
	fallback: React.ReactNode;
}) {
	const [order, setOrder] = useState<Order | null | undefined>(undefined);
	useEffect(() => {
		let current = true;
		getBuyerOrder({ data: { threadId, ...(orderId ? { orderId } : {}) } })
			.then((o) => current && setOrder(o))
			.catch(() => current && setOrder(null));
		return () => {
			current = false;
		};
	}, [threadId, orderId]);
	if (!order) return <>{fallback}</>;
	return <OrderStrip order={order} />;
}

// Above a marketplace email: each order it names that katasync has.
export function MailOrders({ emailId }: { emailId: number }) {
	const [found, setFound] = useState<Found | null>(null);
	useEffect(() => {
		let current = true;
		getMailOrders({ data: { id: emailId } })
			.then((f) => current && setFound(f))
			.catch(() => current && setFound(null));
		return () => {
			current = false;
		};
	}, [emailId]);
	if (!found || found.orders.length === 0) return null;
	return (
		<div className="flex flex-col gap-2 border-b px-5 py-3">
			{found.orders.map((o) => (
				<OrderStrip key={o.id} order={o} />
			))}
			{found.more > 0 && (
				<p className="text-sm text-muted-foreground">
					+{formatCount(found.more)} more{" "}
					{found.more === 1 ? "order" : "orders"}
				</p>
			)}
		</div>
	);
}

// Its status first, where a list of them is scanned.
function OrderStrip({ order }: { order: Order }) {
	const [first] = order.lines;
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 animate-in fade-in-0">
			{/* The status stays beside the products; the title gives way. */}
			<span className="flex min-w-0 max-w-full items-center gap-2">
				<OrderStatusBadge status={order.status} />
				<Link
					to="/orders/$id"
					params={{ id: String(order.id) }}
					className="flex min-w-0 items-center gap-2 rounded-lg hover:bg-surface"
				>
					<span className="flex shrink-0 gap-1">
						{order.lines.slice(0, 3).map((l) => (
							<ProductImage key={l.id} src={l.imageUrl} className="size-8" />
						))}
						{order.lines.length > 3 && (
							<span className="flex size-8 items-center justify-center rounded-lg border bg-subtle text-xs font-semibold text-muted-foreground tabular-nums">
								+{formatCount(order.lines.length - 3)}
							</span>
						)}
					</span>
					<span
						className={cn(
							"truncate text-sm",
							order.lines.length > 1 && "text-muted-foreground",
						)}
					>
						{order.lines.length === 1 && first
							? `${first.title}${first.quantity > 1 ? ` × ${formatCount(first.quantity)}` : ""}`
							: `${formatCount(order.lines.length)} products`}
					</span>
				</Link>
			</span>
			{order.packages.map((p) => (
				<PackageChip key={p.key} pkg={p} />
			))}
		</div>
	);
}

// Its timeline when the carrier has scanned it, every scan on hover, aged
// with an amber dot when they couldn't be refreshed; otherwise when it
// shipped, and why there are no scans.
function PackageChip({ pkg: p }: { pkg: Package }) {
	const t = knownOf(p.tracking);
	if (t)
		return (
			<div className="w-56 text-sm">
				<span className="flex items-center gap-2 text-xs text-muted-foreground">
					<a
						href={p.url ?? undefined}
						target="_blank"
						rel="noreferrer"
						className="flex min-w-0 items-center gap-1 tabular-nums hover:text-foreground"
					>
						<span className="truncate">
							{p.carrier} {p.number}
						</span>
						<ExternalLink className="size-3 shrink-0" />
					</a>
					<span className="ml-auto shrink-0">
						<ReadMark read={p.tracking} />
					</span>
				</span>
				<PackageStatus t={t} />
			</div>
		);
	const body = (
		<>
			<Tag className="size-4 shrink-0 text-muted-foreground" />
			<span className="font-medium text-muted-foreground">
				{p.shippedAt ? `Shipped ${formatDay(p.shippedAt)}` : "Shipped"}
			</span>
			<span className="text-muted-foreground">
				{p.carrier} {p.number ?? ""}
			</span>
			{p.url && <ExternalLink className="size-3 text-muted-foreground" />}
			<span className="text-xs text-muted-foreground">
				<ReadMark read={p.tracking} />
			</span>
		</>
	);
	const chip =
		"flex items-center gap-1.5 rounded-lg border px-2 py-1 text-sm tabular-nums";
	return (
		<Tip content={p.service}>
			{p.url ? (
				<a
					href={p.url}
					target="_blank"
					rel="noreferrer"
					className={cn(chip, "hover:bg-surface")}
				>
					{body}
				</a>
			) : (
				<span className={chip}>{body}</span>
			)}
		</Tip>
	);
}
