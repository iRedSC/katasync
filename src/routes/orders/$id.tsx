import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, Printer, Truck, Undo2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ChannelBadge } from "#/components/channel-badge";
import { MatchDialog } from "#/components/match-picker";
import { DetailsCard } from "#/components/order-page/details-card";
import { EmailBuyer } from "#/components/order-page/email-buyer";
import { FromStoreBadge } from "#/components/order-page/from-store";
import { Line } from "#/components/order-page/line";
import { MailCard } from "#/components/order-page/mail-card";
import { MessageBuyer } from "#/components/order-page/message-buyer";
import { ProfitCard } from "#/components/order-page/profit-card";
import { hasReturn, ReturnCard } from "#/components/order-page/return-card";
import { SendRow } from "#/components/order-page/send-row";
import { TimelineCard } from "#/components/order-page/timeline-card";
import { TrackingCard } from "#/components/order-page/tracking-card";
import { OrderStatusBadge } from "#/components/order-status";
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
	formatDate,
	formatMoney,
	formatOrderDate,
	formatPhone,
} from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism, optimistic, type Patch } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { externalFulfillment } from "#/orders/fulfillment";
import { isLabeled, orderStatus, returnBlocker } from "#/orders/status";
import { printLabels } from "#/printing/qz-client";
import { getBuyerChat } from "#/server/buyer-chat";
import {
	getOrder,
	markOrderNoReturn,
	type OrderDetail,
	receiveOrderReturn,
	undoOrderNoReturn,
	undoOrderReturn,
} from "#/server/orders";

export const Route = createFileRoute("/orders/$id")({
	// The buyer's conversation open over the page.
	validateSearch: (search: Record<string, unknown>): { chat?: number } =>
		Number.isInteger(search.chat) && Number(search.chat) > 0
			? { chat: Number(search.chat) }
			: {},
	loaderDeps: ({ search }) => ({ chat: search.chat }),
	loader: async ({ params, deps }) => {
		const [detail, chat] = await Promise.all([
			getOrder({ data: { id: Number(params.id) } }),
			deps.chat
				? getBuyerChat({
						data: { threadId: deps.chat, orderId: Number(params.id) },
					})
				: null,
		]);
		return { ...detail, buyerChat: chat };
	},
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

// Taking a received return back: it leaves the Return card, and its units
// leave the line's returned (and restocked) counts.
const takenBackPatch = (
	orderId: number,
	r: OrderDetail["returnsReceived"][number],
): Patch =>
	orderData.patch(orderId, (d) => ({
		...d,
		returnsReceived: d.returnsReceived.filter((x) => x.id !== r.id),
		lines: d.lines.map((l) =>
			l.id !== r.lineId
				? l
				: {
						...l,
						returned: l.returned - r.quantity,
						restocked:
							r.restocked || r.refurb || r.preCutover
								? l.restocked - r.quantity
								: l.restocked,
					},
		),
	}));

function OrderPage() {
	const loaded = Route.useLoaderData();
	const search = Route.useSearch();
	const detail = orderData.useData(loaded.order.id, loaded);
	const {
		order,
		lines,
		sends,
		adminUrls,
		profit,
		charges,
		checks,
		rebills,
		buyerOrders,
	} = detail;
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
		.map((l) => ({
			...l,
			left: l.returnQuantity - l.returned - l.onBench.length,
		}))
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
	// Takes a received return back off, long after its own Undo toast is
	// gone: restocked units leave the shelf and the order is due again.
	async function takeBack(r: OrderDetail["returnsReceived"][number]) {
		const line = lines.find((l) => l.id === r.lineId);
		const what = `${formatCount(r.quantity)} × ${line?.sku ?? line?.title ?? "an item"}`;
		const done = await optimism.change({
			label: `Taking back return on ${order.name}`,
			patch: takenBackPatch(order.id, r),
			send: () => undoOrderReturn({ data: { ids: [r.id] } }),
		});
		if (!done) return;
		if (done.value.problems.length > 0)
			toast.error(done.value.problems.join("; "));
		offerUndo(`Return on ${order.name} taken back`, {
			description: r.restocked || r.refurb ? `${what} off the shelf` : what,
			undo: async () => {
				// Nothing to lay over: the reload shows it received again.
				const again = await optimism.change({
					send: () =>
						receiveOrderReturn({
							data: {
								orderId: order.id,
								lines: [{ lineId: r.lineId, quantity: r.quantity }],
								outcome: r.refurb
									? { refurbishInto: r.refurb.id }
									: r.restocked
										? "restock"
										: "write_off",
							},
						}),
				});
				return again && `Return on ${order.name} received again`;
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
					<OrderStatusBadge status={status} />
					{order.pin !== null && (
						<span className="font-mono text-base text-muted-foreground">
							Pin {order.pin}
						</span>
					)}
				</span>
			}
		>
			<p className="-mt-3 flex items-center gap-2 text-muted-foreground">
				<ChannelBadge
					channel={order.channel}
					salesChannel={order.salesChannel}
				/>
				{formatOrderDate(order.placedAt)}
			</p>
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

			<div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<div className="flex flex-col gap-4">
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
													{formatCount(l.returned - l.restocked)} returned
													damaged
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
							<Line
								label="Total paid"
								value={formatMoney(order.total)}
								strong
							/>
						</dl>
					</Card>
					{hasReturn(detail) && (
						<ReturnCard
							detail={detail}
							canReceive={canReturn}
							onReceive={() => setReturning(true)}
							onNothing={nothingComing}
							onTakeBack={takeBack}
						/>
					)}
					<MailCard mail={detail.mail} />
					<TimelineCard detail={detail} />
				</div>

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
					<TrackingCard orderId={order.id} />
					{profit && (
						<ProfitCard
							profit={profit}
							charges={charges}
							checks={checks}
							rebills={rebills}
						/>
					)}
					<Card title="Customer">
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
						<MessageBuyer
							orderId={order.id}
							way={detail.chat}
							chatId={search.chat}
							chat={loaded.buyerChat}
						/>
						{detail.emailBuyer && (
							<EmailBuyer
								orderId={order.id}
								email={detail.emailBuyer}
								started={detail.mail.threads.some(
									(t) => t.market === "shopify",
								)}
							/>
						)}
						{buyerOrders.length > 0 && (
							<div className="mt-3 border-t pt-3">
								<p className="mb-1.5 flex justify-between text-xs text-muted-foreground">
									<span>
										{formatCount(buyerOrders.length)} other{" "}
										{buyerOrders.length === 1 ? "order" : "orders"}
									</span>
									<span className="tabular-nums">
										{formatMoney(
											buyerOrders
												.filter((b) => !b.cancelledAt)
												.reduce((n, b) => n + b.total, 0),
										)}
									</span>
								</p>
								<ul className="flex flex-col gap-1">
									{buyerOrders.map((b) => (
										<li key={b.id}>
											<Link
												to="/orders/$id"
												params={{ id: String(b.id) }}
												className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-subtle"
											>
												<ChannelBadge
													channel={b.channel}
													salesChannel={b.salesChannel}
													compact
												/>
												<span
													className={`min-w-0 flex-1 truncate font-medium ${b.cancelledAt ? "text-muted-foreground line-through" : ""}`}
												>
													{b.name}
												</span>
												<span className="text-xs text-muted-foreground">
													{formatDate(b.placedAt)}
												</span>
												<span className="w-16 text-right tabular-nums">
													{formatMoney(b.total)}
												</span>
											</Link>
										</li>
									))}
								</ul>
							</div>
						)}
					</Card>
					<DetailsCard detail={detail} />
				</div>
			</div>
		</Page>
	);
}
