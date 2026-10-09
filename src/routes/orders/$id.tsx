import {
	createFileRoute,
	Link,
	useCanGoBack,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { Badge, Banner, Card, Page } from "#/components/page";
import { ProductImage } from "#/components/product";
import { formatCount, formatMoney, formatOrderDate } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { orderStatus } from "#/orders/status";
import { getOrder } from "#/server/orders";

export const Route = createFileRoute("/orders/$id")({
	loader: ({ params }) => getOrder({ data: { id: Number(params.id) } }),
	component: OrderPage,
});

function OrderPage() {
	const { order, lines } = Route.useLoaderData();
	const router = useRouter();
	const navigate = useNavigate();
	const canGoBack = useCanGoBack();
	const status = orderStatus(order);
	// No SKU means a custom item; only real SKUs need matching.
	const unmatched = lines.filter(
		(l) => l.productSku === null && l.sku !== null,
	);
	const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

	useHotkeys({
		Escape: () =>
			canGoBack ? router.history.back() : navigate({ to: "/orders" }),
	});

	return (
		<Page
			narrow
			back={{ to: "/orders" }}
			title={
				<span className="flex items-center gap-2">
					{order.name}
					<Badge tone={status.tone}>{status.label}</Badge>
					{order.pin !== null && (
						<span className="font-mono text-base text-muted-foreground">
							Pin {order.pin}
						</span>
					)}
				</span>
			}
		>
			<p className="-mt-3 text-muted-foreground">
				{formatOrderDate(order.placedAt)} on {order.salesChannel ?? order.store}
			</p>

			{unmatched.length > 0 && (
				<Banner
					tone="critical"
					title={`${unmatched.length === 1 ? "One item isn't" : `${unmatched.length} items aren't`} matched to a product`}
					action={{ label: "Match listings", link: { to: "/listings" } }}
				>
					katasync can't take stock for{" "}
					{unmatched.map((l) => l.sku ?? l.title).join(", ")} until the listing
					is matched.
				</Banner>
			)}

			<div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<Card title="Items" flush>
					<ul>
						{lines.map((l) => (
							<li
								key={l.id}
								className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0"
							>
								<ProductImage src={l.imageUrl} className="size-10" />
								<div className="min-w-0 flex-1">
									{l.productSku ? (
										<Link
											to="/products/$sku"
											params={{ sku: l.productSku }}
											className="block truncate font-medium hover:underline"
										>
											{l.title}
										</Link>
									) : (
										<div className="truncate font-medium">{l.title}</div>
									)}
									<div className="flex gap-2 text-xs text-muted-foreground">
										<span>{l.sku ?? "No SKU"}</span>
										{l.productSku === null && l.sku !== null && (
											<Badge tone="critical">Unknown product</Badge>
										)}
									</div>
								</div>
								<div className="text-right whitespace-nowrap tabular-nums">
									<div>
										{formatMoney(l.unitPrice)} × {formatCount(l.quantity)}
									</div>
									<div className="font-semibold">
										{formatMoney(l.unitPrice * l.quantity)}
									</div>
								</div>
							</li>
						))}
					</ul>
					<dl className="flex flex-col gap-1 border-t bg-[#f7f7f7] px-4 py-3">
						<Line label="Items" value={formatMoney(subtotal)} />
						<Line
							label="Shipping charged"
							value={formatMoney(order.shippingCharged)}
						/>
						<Line label="Total paid" value={formatMoney(order.total)} strong />
					</dl>
				</Card>

				<div className="flex flex-col gap-4">
					<Card title="Ship to">
						<p className="font-medium">{order.customerName ?? "No name"}</p>
						<p className="text-muted-foreground">
							{[order.shipCity, order.shipRegion, order.shipCountry]
								.filter(Boolean)
								.join(", ") || "No shipping address"}
						</p>
					</Card>
				</div>
			</div>
		</Page>
	);
}

function Line({
	label,
	value,
	strong = false,
}: {
	label: string;
	value: string;
	strong?: boolean;
}) {
	return (
		<div className="flex justify-between">
			<dt className={strong ? "font-semibold" : "text-muted-foreground"}>
				{label}
			</dt>
			<dd className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>
				{value}
			</dd>
		</div>
	);
}
