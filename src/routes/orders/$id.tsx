import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, Printer, Truck, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge, Card, Page, useBack } from "#/components/page";
import { ProductImage } from "#/components/product";
import {
	type IndexEntry,
	ProductSearchDialog,
} from "#/components/product-search-dialog";
import { openQuickShip } from "#/components/quick-ship";
import { type Received, ReturnDialog } from "#/components/return-dialog";
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
import { externalFulfillment } from "#/orders/fulfillment";
import { isLabeled, orderStatus, returnBlocker } from "#/orders/status";
import { printLabels } from "#/printing/qz-client";
import { linkSku } from "#/server/catalog";
import { getOrder, type OrderDetail } from "#/server/orders";
import { resendTracking, voidLabel } from "#/server/shipping";

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
// restocked count when it went back on the shelf. Undo takes it off again.
const returnedPatch =
	(orderId: number, sign: 1 | -1) =>
	(received: Received[], restock: boolean): Patch =>
		orderData.patch(orderId, (d) => ({
			...d,
			lines: d.lines.map((l) => {
				const got = received.find((r) => r.lineId === l.id);
				if (!got) return l;
				const n = sign * got.quantity;
				return {
					...l,
					returned: l.returned + n,
					restocked: restock ? l.restocked + n : l.restocked,
				};
			}),
		}));

function OrderPage() {
	const loaded = Route.useLoaderData();
	const { order, lines, sends, adminUrl, profit, charges, reports, checks } =
		orderData.useData(loaded.order.id, loaded);
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
		.map((l) => ({ ...l, left: l.quantity - l.returned }))
		.filter((l) => l.left > 0);
	const canReturn =
		returnBlocker({ ...order, labeled: isLabeled(profit?.labelsStatus) }) ===
			null && returnable.length > 0;
	// Refunded in full: what hasn't come back yet is expected.
	const awaitingReturn = profit?.awaitingReturn ?? false;
	const [returning, setReturning] = useState(false);
	// The SKU being linked to a product.
	const [linking, setLinking] = useState<string | null>(null);

	// Saves the SKU as the product's alias. Every line sold under it shows the
	// product at once; the server catches up stock behind it.
	async function link(alias: string, product: IndexEntry) {
		const r = await optimism.change({
			label: `Linking ${alias} to ${product.sku}`,
			patch: orderData.patch(order.id, (d) => ({
				...d,
				lines: d.lines.map((l) =>
					l.sku === alias && l.productSku === null
						? { ...l, productSku: product.sku, productName: product.name }
						: l,
				),
			})),
			send: () => linkSku({ data: { alias, sku: product.sku } }),
		});
		if (!r) return;
		const { sku, ordersUpdated, problems } = r.value;
		if (problems.length > 0) {
			toast.warning(`Linked ${alias} to ${sku}, but stock wasn't taken`, {
				description: problems.join(". "),
			});
			return;
		}
		toast.success(`Linked ${alias} to ${sku}`, {
			description: `${formatCount(ordersUpdated)} order ${ordersUpdated === 1 ? "line" : "lines"} updated`,
		});
	}
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
								{status.label === "Fulfill externally" ? "Fulfill" : "View"} on{" "}
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

			<ProductSearchDialog
				title={
					linking && (
						<>
							<span className="font-semibold">Link {linking}</span>{" "}
							<span className="text-muted-foreground">
								to a product, here and on every channel
							</span>
						</>
					)
				}
				startFrom={linking}
				onClose={() => setLinking(null)}
				onPick={(product) => {
					const alias = linking;
					setLinking(null);
					if (alias) link(alias, product);
				}}
			/>

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
										{l.productSku === null && l.sku !== null && (
											<>
												<Badge tone="critical">
													Not linked, no stock taken
												</Badge>
												<button
													type="button"
													onClick={() => setLinking(l.sku)}
													className="font-medium text-link hover:underline"
												>
													Link product
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

const feesNote: Record<string, string | undefined> = {
	final: undefined,
	reported: "As reported so far; may still change",
	estimated: "Estimated until the marketplace reports it",
};
const labelsNote: Record<string, string | undefined> = {
	known: undefined,
	stand_in: "katasync's estimate until TikTok bills it",
	not_needed: undefined,
	not_shipped: "Not shipped yet",
	awaiting: "Waiting for the marketplace to report",
	missing: "Shipped, but no label cost from anyone. Bought somewhere else?",
};

// What the order made, and what each marketplace said it charged
// (src/orders/profit.ts). Anything not final says so.
function ProfitCard({
	profit: p,
	charges,
	reports,
	checks,
}: Pick<OrderDetail, "charges" | "reports" | "checks"> & {
	profit: NonNullable<OrderDetail["profit"]>;
}) {
	const failed = checks.filter((c) => c.error);
	return (
		<Card
			title="Profit"
			aside={
				p.complete ? undefined : (
					<Badge tone="warning">
						{p.awaitingReturn ? "Awaiting return" : "Waiting on a cost"}
					</Badge>
				)
			}
		>
			<dl className="flex flex-col gap-1">
				<Line label="Items" value={formatMoney(p.revenue)} />
				<Line label="Shipping charged" value={formatMoney(p.shippingCharged)} />
				<Line
					label="Cost of goods"
					value={formatMoney(-p.cost)}
					note={
						!p.costKnown
							? "A product has no cost"
							: p.awaitingReturn
								? "Refunded items not back yet aren't counted; they are if written off, or still out 60 days after the sale"
								: undefined
					}
				/>
				<Line
					label="Marketplace fees"
					value={formatMoney(-p.fees)}
					note={feesNote[p.feesStatus]}
				/>
				<Line
					label="Shipping labels"
					value={formatMoney(-p.labels)}
					note={labelsNote[p.labelsStatus]}
				/>
				{p.refunds !== 0 && (
					<Line label="Refunds" value={formatMoney(-p.refunds)} />
				)}
				{p.adjustments !== 0 && (
					<Line label="Adjustments" value={formatMoney(-p.adjustments)} />
				)}
				<div className="mt-1 border-t pt-1">
					<Line label="Profit" value={formatMoney(p.profit)} strong />
				</div>
			</dl>
			{charges.length > 0 && (
				<details className="mt-3 text-xs">
					<summary className="cursor-pointer text-muted-foreground">
						{formatCount(charges.length)} charges reported
					</summary>
					<ul className="mt-1 flex flex-col gap-0.5">
						{charges.map((c, i) => (
							// Charges have no identity of their own on the page.
							// biome-ignore lint/suspicious/noArrayIndexKey: listed in order, never reordered
							<li key={i} className="flex justify-between gap-2">
								<span className="text-muted-foreground">
									{channelName(c.billedBy)}: {c.description}
								</span>
								<span className="tabular-nums">{formatMoney(-c.amount)}</span>
							</li>
						))}
					</ul>
				</details>
			)}
			{reports.length === 0 && checks.length === 0 && (
				<p className="mt-3 text-xs text-muted-foreground">
					Not asked about yet; the marketplace is asked within ten minutes.
				</p>
			)}
			{failed.map((c) => (
				<p key={c.billedBy} className="mt-3 text-xs text-critical-text">
					Asking {channelName(c.billedBy)} failed: {c.error}
				</p>
			))}
		</Card>
	);
}

function Line({
	label,
	value,
	strong = false,
	note,
}: {
	label: string;
	value: string;
	strong?: boolean;
	// Why the figure isn't final, under the label.
	note?: string;
}) {
	return (
		<div className="flex justify-between gap-3">
			<dt className={strong ? "font-semibold" : "text-muted-foreground"}>
				{label}
				{note && <div className="text-xs text-warning-text">{note}</div>}
			</dt>
			<dd className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>
				{value}
			</dd>
		</div>
	);
}

// One shipment: its boxes' labels, where this order's tracking stands, the
// other orders packed with it, a retry when tracking didn't reach the
// marketplace, and a two-step void of every box.
function SendRow({
	send: d,
	channel,
}: {
	send: OrderDetail["sends"][number];
	channel: string;
}) {
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	const live = d.boxes.filter((b) => b.voidedAt === null);
	const first = d.boxes[0];
	const test = d.boxes.some((b) => b.test);

	// Talks to a carrier or marketplace, so it waits for the reload that shows
	// it. A failure is toasted by the engine; a success is said once it's shown.
	async function act(work: () => Promise<string>) {
		setBusy(true);
		const r = await optimism.change({ send: work });
		setBusy(false);
		setConfirm(false);
		if (r) toast.success(r.value);
	}

	// Sending tracking needs every box bought and none voided.
	const sendable = d.complete && live.length === d.boxes.length;
	const state = !d.live
		? {
				tone: undefined,
				text: `Voided · refund ${(first?.refundStatus ?? "requested").toLowerCase()}`,
			}
		: !sendable
			? { tone: "critical" as const, text: "Incomplete, void it" }
			: test
				? { tone: "info" as const, text: "Test label" }
				: d.channelSentAt
					? { tone: "success" as const, text: `Tracking sent to ${channel}` }
					: d.channelError
						? { tone: "critical" as const, text: "Tracking not sent" }
						: { tone: "warning" as const, text: "Tracking pending" };

	return (
		<li className="flex flex-col gap-2 border-t px-4 py-3 first:border-t-0">
			<div className="flex items-start justify-between gap-2">
				<div className={d.live ? "" : "text-muted-foreground line-through"}>
					<p className="font-medium">
						{first?.serviceName}
						{d.boxes.length > 1 && ` · ${d.boxes.length} boxes`}
					</p>
					<p className="tabular-nums">
						{formatMoney(d.boxes.reduce((sum, b) => sum + b.cost, 0))}
					</p>
				</div>
				<Badge tone={state.tone}>{state.text}</Badge>
			</div>
			{d.shippedWith.length > 0 && (
				<p>
					Shipped together with{" "}
					{d.shippedWith.map((o, i) => (
						<span key={o.id}>
							{i > 0 && ", "}
							<Link
								to="/orders/$id"
								params={{ id: String(o.id) }}
								className="font-medium text-link hover:underline"
							>
								{o.name}
							</Link>
						</span>
					))}
				</p>
			)}
			<ul className="flex flex-col gap-1">
				{d.boxes.map((b, i) => (
					<li
						key={b.id}
						className={`flex items-center gap-2 text-xs ${b.voidedAt ? "text-muted-foreground line-through" : ""}`}
					>
						{d.boxes.length > 1 && <span>Box {i + 1}</span>}
						{b.trackingNumber && (
							<a
								href={b.trackingUrl ?? undefined}
								target="_blank"
								rel="noreferrer"
								className="font-mono text-link hover:underline"
							>
								{b.trackingNumber}
							</a>
						)}
						{!b.voidedAt && (
							<button
								type="button"
								onClick={() => printLabels([b.id])}
								className="text-link hover:underline"
							>
								Print
							</button>
						)}
						{b.storefrontTrackingError && (
							<p className="text-warning-text">{b.storefrontTrackingError}</p>
						)}
					</li>
				))}
			</ul>
			{d.channelError && !d.channelSentAt && d.live && (
				<p className="text-critical-text">{d.channelError}</p>
			)}
			{!d.live && d.unfinishedVoid && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-critical-text">Voiding didn't finish.</span>
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() =>
							act(async () => {
								const r = await voidLabel({ data: { dispatchId: d.id } });
								return r.notes.join(" ") || "Voiding finished";
							})
						}
					>
						Finish voiding
					</Button>
				</div>
			)}
			{d.live && (
				<div className="flex flex-wrap gap-2">
					{sendable && !d.channelSentAt && !test && (
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() =>
								act(async () => {
									const r = await resendTracking({
										data: { dispatchId: d.id },
									});
									if (!r.sent) throw new Error(r.message);
									return r.message;
								})
							}
						>
							Send tracking
						</Button>
					)}
					{/* TikTok has no API to cancel its labels. */}
					{live.some((b) => b.provider === "tiktok") ? (
						<span className="self-center text-xs text-muted-foreground">
							Cancel in TikTok Seller Center
						</span>
					) : confirm ? (
						<Button
							size="sm"
							variant="destructive"
							disabled={busy}
							onClick={() =>
								act(async () => {
									const r = await voidLabel({ data: { dispatchId: d.id } });
									// Some refunds refused: say so as a failure; Void stays.
									if (r.remaining > 0) throw new Error(r.notes.join(" "));
									return [
										`Voided, refund ${r.refundStatus.toLowerCase()}.`,
										...r.notes,
									].join(" ");
								})
							}
						>
							Void and refund{" "}
							{formatMoney(live.reduce((sum, b) => sum + b.cost, 0))}
							{d.shippedWith.length > 0 && " for every order in the box"}?
						</Button>
					) : (
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => setConfirm(true)}
						>
							{live.length > 1 ? "Void all labels" : "Void"}
						</Button>
					)}
				</div>
			)}
		</li>
	);
}
