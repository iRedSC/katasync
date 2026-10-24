import { createFileRoute, Link } from "@tanstack/react-router";
import { Ban, ExternalLink, Printer, Truck, Undo2 } from "lucide-react";
import { useCallback, useState } from "react";
import { MatchDialog } from "#/components/match-picker";
import { FromStoreBadge } from "#/components/order-page/from-store";
import { Line } from "#/components/order-page/line";
import { ProfitCard } from "#/components/order-page/profit-card";
import { SendRow } from "#/components/order-page/send-row";
import { Badge, Card, Page, useBack } from "#/components/page";
import { ProductImage } from "#/components/product";
import { openQuickShip } from "#/components/quick-ship";
import {
	type Outcome,
	type Received,
	ReturnDialog,
} from "#/components/return-dialog";
import { DetailSkeleton, FieldsCard, ListCard } from "#/components/skeleton";
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
import { optimism, optimistic, type Patch } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { externalFulfillment } from "#/orders/fulfillment";
import { returnReason } from "#/orders/return-reasons";
import { isLabeled, orderStatus, returnBlocker } from "#/orders/status";
import { printLabels } from "#/printing/qz-client";
import {
	getOrder,
	markOrderNoReturn,
	type OrderDetail,
	undoOrderNoReturn,
} from "#/server/orders";

export const Route = createFileRoute("/orders/$id")({
	loader: ({ params }) => getOrder({ data: { id: Number(params.id) } }),
	component: OrderPage,
	pendingComponent: () => (
		<DetailSkeleton
			back={{ to: "/orders" }}
			main={<ListCard title="Items" rows={3} picture />}
			side={<FieldsCard title="Ship to" lines={4} />}
		/>
	),
});

// The page's data with changes the server hasn't confirmed laid over it.
const orderData = optimistic<OrderDetail>("order");

// Receiving a return counts it against each line, and against the line's
// restocked count when it went back on a shelf (its own or a refurb's).
// Undo takes it off again.
const returnedPatch =
	(orderId: number, sign: 1 | -1) =>
	(received: Received[], outcome: Outcome): Patch =>
		orderData.patch(orderId, (d) => ({
			...d,
			lines: d.lines.map((l) => {
				const got = received.find((r) => r.lineId === l.id);
				if (!got) return l;
				const n = sign * got.quantity;
				return {
					...l,
					returned: l.returned + n,
					restocked: outcome === "write_off" ? l.restocked : l.restocked + n,
				};
			}),
		}));

function OrderPage() {
	const loaded = Route.useLoaderData();
	const {
		order,
		lines,
		sends,
		adminUrls,
		profit,
		charges,
		reports,
		checks,
		returnState,
		returnRequests,
	} = orderData.useData(loaded.order.id, loaded);
	const goBack = useBack({ to: "/orders" });
	const status = orderStatus(order);
	const external = externalFulfillment(order);
	const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
	// Shippable here: still to ship (it has a pin), not a marketplace label,
	// and no live label yet.
	const pin = order.pin;
	// One live shipment per order; voided ones stay listed under Shipments.
	const liveSend = sends.find((d) => d.live);
	const liveBoxes = liveSend?.boxes.filter((b) => b.voidedAt === null) ?? [];
	const canShip = pin !== null && !external && !liveSend;
	// Cancelled or refunded with a live label: that box mustn't go out.
	const toVoid =
		order.labelToVoid && liveSend && liveBoxes.length > 0
			? { send: liveSend, boxes: liveBoxes }
			: null;
	const ship = () => pin !== null && openQuickShip(pin);
	// Returns come back here once everything has left our shelf.
	const returnable = lines
		.map((l) => ({ ...l, left: l.returnQuantity - l.returned }))
		.filter((l) => l.left > 0);
	const canReturn =
		returnBlocker({
			...order,
			labeled: isLabeled(profit?.labelsStatus),
			shippedQuantity: order.committedStock
				? returnable.reduce((total, line) => total + line.left, 0)
				: undefined,
		}) === null && returnable.length > 0;
	// Refunded in full: what hasn't come back yet is expected.
	const awaitingReturn = profit?.awaitingReturn ?? false;
	const [returning, setReturning] = useState(false);

	// The buyer kept it, or it was lost: its refund's items are a cost now,
	// and it leaves Returns.
	async function nothingComing() {
		const r = await optimism.change({
			label: `Nothing coming back on ${order.name}`,
			patch: orderData.patch(order.id, (d) => ({
				...d,
				returnState: null,
				profit: d.profit && { ...d.profit, awaitingReturn: false },
			})),
			send: () => markOrderNoReturn({ data: { orderId: order.id } }),
		});
		if (!r) return;
		offerUndo(`Nothing coming back on ${order.name}`, {
			description: awaitingReturn ? "Its items count as a cost now" : undefined,
			undo: async () => {
				// Nothing to lay over: the reload shows what's due again.
				const undone = await optimism.change({
					send: () =>
						undoOrderNoReturn({
							data: { orderId: order.id, previous: r.value.previous },
						}),
				});
				return undone && `${order.name} is back on Returns`;
			},
		});
	}
	// Picking products for this order's unmatched listings.
	const [matching, setMatching] = useState(false);
	const closeMatch = useCallback(() => setMatching(false), []);
	const address = [
		order.shipAddress1,
		order.shipAddress2,
		cityLine(order.shipCity, order.shipRegion, order.shipPostalCode),
		order.shipCountry,
	].filter(Boolean);

	useHotkeys({
		Escape: goBack,
		...(canShip ? { s: ship } : {}),
		...(canReturn ? { r: () => setReturning(true) } : {}),
	});

	return (
		<Page
			width="narrow"
			back={{ to: "/orders" }}
			actions={
				<>
					{adminUrls.map((admin) => (
						<Button key={admin.name} asChild size="sm" variant="ghost">
							<a href={admin.url} target="_blank" rel="noreferrer">
								Open in {admin.name}
								<ExternalLink />
							</a>
						</Button>
					))}
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
					{liveBoxes.length > 0 && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => printLabels(liveBoxes.map((box) => box.id))}
						>
							<Printer />
							Reprint {liveBoxes.length > 1 ? "labels" : "label"}
						</Button>
					)}
					{external && (
						<Button asChild size="sm">
							<a href={external.url} target="_blank" rel="noreferrer">
								{status.key === "external" ? "Fulfill" : "View"} on{" "}
								{external.name}
								<ExternalLink />
							</a>
						</Button>
					)}
					{returnState && (
						<Button size="sm" variant="ghost" onClick={nothingComing}>
							<Ban />
							Nothing coming back
						</Button>
					)}
					{canReturn && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setReturning(true)}
						>
							<Undo2 />
							Receive return
							<kbd className="ml-1 rounded bg-black/5 px-1 text-xs">R</kbd>
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
			{returnRequests.map((r) => (
				<p key={`${r.billedBy}${r.requestedAt.getTime()}`} className="-mt-2">
					<Badge
						tone={
							r.status === "closed" || r.status === "cancelled"
								? undefined
								: "info"
						}
					>
						Return {r.rawStatus.toLowerCase().replace(/_/g, " ")}
					</Badge>{" "}
					<span className="text-muted-foreground">
						Opened {formatOrderDate(r.requestedAt)} on {channelName(r.billedBy)}
						{r.reason && `: ${returnReason(r.reason)}`}
						{r.trackingNumber &&
							`, tracking ${r.carrier ? `${r.carrier} ` : ""}${r.trackingNumber}`}
					</span>
				</p>
			))}

			<MatchDialog orderId={matching ? order.id : null} onClose={closeMatch} />

			{returning && (
				<ReturnDialog
					open
					onOpenChange={setReturning}
					orderId={order.id}
					orderName={order.name}
					lines={returnable}
					patches={{
						receive: returnedPatch(order.id, 1),
						undo: returnedPatch(order.id, -1),
					}}
				/>
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
								<div
									className={`min-w-0 flex-1 ${l.quantity === 0 ? "text-muted-foreground" : ""}`}
								>
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
										<span>
											{l.sku ?? "No SKU"}
											{l.productSku && l.sku !== l.productSku && (
												<> → {l.productSku}</>
											)}
										</span>
										{l.quantity === 0 && <Badge>Cancelled</Badge>}
										<FromStoreBadge parts={l.fromStore} sku={l.productSku} />
										{l.restocked > 0 && (
											<Badge tone="info">
												{formatCount(l.restocked)} returned to shelf
											</Badge>
										)}
										{l.returned > l.restocked && (
											<Badge>
												{formatCount(l.returned - l.restocked)} returned damaged
											</Badge>
										)}
										{awaitingReturn &&
											l.tookStock &&
											l.quantity > l.returned && (
												<Badge tone="warning">
													{formatCount(l.quantity - l.returned)} refunded, not
													back yet
												</Badge>
											)}
										{l.awaitsMatch && (
											<>
												<Badge tone="critical">No stock taken</Badge>
												<button
													type="button"
													onClick={() => setMatching(true)}
													className="font-medium text-link hover:underline"
												>
													Match
												</button>
											</>
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
					<dl className="flex flex-col gap-1 border-t bg-subtle px-4 py-3">
						<Line label="Items" value={formatMoney(subtotal)} />
						<Line
							label="Shipping charged"
							value={formatMoney(order.shippingCharged)}
						/>
						<Line label="Total paid" value={formatMoney(order.total)} strong />
					</dl>
				</Card>

				<div className="flex flex-col gap-4">
					{sends.length > 0 && (
						<Card
							title="Shipments"
							flush
							{...(toVoid && {
								tone: "critical",
								aside: "Don't ship this box",
							})}
						>
							{toVoid && (
								<p className="border-b bg-critical-surface px-4 pb-3 text-critical-text">
									{order.cancelledAt ? "Cancelled" : "Refunded"} after its label
									was bought.{" "}
									{toVoid.boxes[0].provider === "tiktok"
										? "Cancel the label in TikTok Seller Center."
										: `Void the ${toVoid.boxes[0].serviceName} ${toVoid.boxes.length > 1 ? "labels" : "label"} to get ${formatMoney(toVoid.boxes.reduce((sum, b) => sum + b.cost, 0))} back.`}
									{toVoid.send.shippedWith.length > 0 &&
										` Voiding also sends ${toVoid.send.shippedWith.map((o) => o.name).join(", ")} back to To ship.`}
								</p>
							)}
							<ul>
								{sends.map((d) => (
									<SendRow
										key={d.id}
										send={d}
										channel={channelName(order.channel)}
									/>
								))}
							</ul>
						</Card>
					)}
					{profit && (
						<ProfitCard
							profit={profit}
							charges={charges}
							reports={reports}
							checks={checks}
						/>
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
