import {
	createFileRoute,
	Link,
	useCanGoBack,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { ExternalLink, Printer, Truck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge, Banner, Card, Page } from "#/components/page";
import { ProductImage } from "#/components/product";
import { openQuickShip } from "#/components/quick-ship";
import { Button } from "#/components/ui/button";
import {
	channelName,
	cityLine,
	formatCount,
	formatMoney,
	formatOrderDate,
	formatPhone,
} from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { externalFulfillment } from "#/orders/fulfillment";
import { orderStatus } from "#/orders/status";
import { getOrder, type OrderDetail } from "#/server/orders";
import { resendTracking, voidLabel } from "#/server/shipping";

export const Route = createFileRoute("/orders/$id")({
	loader: ({ params }) => getOrder({ data: { id: Number(params.id) } }),
	component: OrderPage,
});

function OrderPage() {
	const { order, lines, labels, adminUrl } = Route.useLoaderData();
	const router = useRouter();
	const navigate = useNavigate();
	const canGoBack = useCanGoBack();
	const status = orderStatus(order);
	const external = externalFulfillment(order);
	// No SKU means a custom item; only real SKUs need matching.
	const unmatched = lines.filter(
		(l) => l.productSku === null && l.sku !== null,
	);
	const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
	// Shippable here: still to ship (it has a pin), not a marketplace label,
	// and no live label yet.
	const pin = order.pin;
	const canShip =
		pin !== null && !external && !labels.some((l) => l.voidedAt === null);
	const ship = () => pin !== null && openQuickShip(pin);
	const address = [
		order.shipAddress1,
		order.shipAddress2,
		cityLine(order.shipCity, order.shipRegion, order.shipPostalCode),
		order.shipCountry,
	].filter(Boolean);

	useHotkeys({
		Escape: () =>
			canGoBack ? router.history.back() : navigate({ to: "/orders" }),
		...(canShip ? { s: ship } : {}),
	});

	return (
		<Page
			narrow
			back={{ to: "/orders" }}
			actions={
				<>
					{adminUrl && (
						<Button asChild size="sm" variant="ghost">
							<a href={adminUrl.url} target="_blank" rel="noreferrer">
								Open in {adminUrl.name}
								<ExternalLink />
							</a>
						</Button>
					)}
					<Button asChild size="sm" variant="outline">
						<a
							href={`/print/invoices?id=${order.id}`}
							target="_blank"
							rel="noreferrer"
						>
							<Printer />
							Print invoice
						</a>
					</Button>
					{external && (
						<Button asChild size="sm">
							<a href={external.url} target="_blank" rel="noreferrer">
								{status.label === "Fulfill externally" ? "Fulfill" : "View"} on{" "}
								{external.name}
								<ExternalLink />
							</a>
						</Button>
					)}
					{canShip && (
						<Button size="sm" onClick={ship}>
							<Truck />
							Ship
							<kbd className="ml-1 rounded bg-white/15 px-1 text-xs">S</kbd>
						</Button>
					)}
				</>
			}
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
				{formatOrderDate(order.placedAt)} on{" "}
				{order.salesChannel ?? channelName(order.channel)}
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
					{labels.length > 0 && (
						<Card title="Labels" flush>
							<ul>
								{labels.map((l) => (
									<LabelRow
										key={l.id}
										label={l}
										channel={channelName(order.channel)}
									/>
								))}
							</ul>
						</Card>
					)}
					<Card title="Ship to">
						<p className="font-medium">{order.customerName ?? "No name"}</p>
						{address.length > 0 ? (
							address.map((l) => <p key={l}>{l}</p>)
						) : (
							<p className="text-muted-foreground">No shipping address</p>
						)}
						{order.shipPhone && (
							<p className="mt-2 text-muted-foreground">
								{formatPhone(order.shipPhone)}
							</p>
						)}
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

// One bought label: where its tracking stands, with a retry when it didn't
// reach the marketplace and a two-step void.
function LabelRow({
	label: l,
	channel,
}: {
	label: OrderDetail["labels"][number];
	channel: string;
}) {
	const router = useRouter();
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);

	async function act(work: () => Promise<string>) {
		setBusy(true);
		try {
			toast.success(await work());
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
			setConfirm(false);
			router.invalidate();
		}
	}

	const state = l.voidedAt
		? {
				tone: undefined,
				text: `Voided · refund ${(l.refundStatus ?? "requested").toLowerCase()}`,
			}
		: l.test
			? { tone: "info" as const, text: "Test label" }
			: l.channelSentAt
				? { tone: "success" as const, text: `Tracking sent to ${channel}` }
				: l.channelError
					? { tone: "critical" as const, text: "Tracking not sent" }
					: { tone: "warning" as const, text: "Tracking not sent yet" };

	return (
		<li className="flex flex-col gap-2 border-t px-4 py-3 first:border-t-0">
			<div className="flex items-start justify-between gap-2">
				<div className={l.voidedAt ? "text-muted-foreground line-through" : ""}>
					<p className="font-medium">{l.serviceName}</p>
					<p className="tabular-nums">{formatMoney(l.cost)}</p>
				</div>
				<Badge tone={state.tone}>{state.text}</Badge>
			</div>
			{l.trackingNumber && (
				<a
					href={l.trackingUrl ?? undefined}
					target="_blank"
					rel="noreferrer"
					className="font-mono text-xs text-link hover:underline"
				>
					{l.trackingNumber}
				</a>
			)}
			{l.channelError && !l.channelSentAt && !l.voidedAt && (
				<p className="text-critical-text">{l.channelError}</p>
			)}
			{!l.voidedAt && (
				<div className="flex flex-wrap gap-2">
					<Button asChild size="sm" variant="outline">
						<a href={l.labelUrl} target="_blank" rel="noreferrer">
							Print
						</a>
					</Button>
					{!l.channelSentAt && !l.test && (
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() =>
								act(async () => {
									const r = await resendTracking({ data: { id: l.id } });
									if (!r.sent) throw new Error(r.message);
									return r.message;
								})
							}
						>
							Send tracking
						</Button>
					)}
					{confirm ? (
						<Button
							size="sm"
							variant="destructive"
							disabled={busy}
							onClick={() =>
								act(async () => {
									const r = await voidLabel({ data: { id: l.id } });
									return [
										`Voided, refund ${r.refundStatus.toLowerCase()}.`,
										...r.notes,
									].join(" ");
								})
							}
						>
							Void and refund {formatMoney(l.cost)}?
						</Button>
					) : (
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => setConfirm(true)}
						>
							Void
						</Button>
					)}
				</div>
			)}
		</li>
	);
}
