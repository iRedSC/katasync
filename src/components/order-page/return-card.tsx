import { Ban, ExternalLink, Printer, Undo2 } from "lucide-react";
import { Badge, Card, type Tone } from "#/components/page";
import { ProductImage } from "#/components/product";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import type { ReturnState } from "#/db/schema";
import { channelName, formatCount, formatOrderDate } from "#/lib/format";
import { returnReason } from "#/orders/return-reasons";
import { printPdf } from "#/printing/qz-client";
import type { OrderDetail } from "#/server/orders";

// Where an order's return stands, all in one place: what's due back and
// why, each request the buyer opened on a marketplace, and every return
// received, each of which can be taken back. Shown only when something
// about a return has happened.

export const RETURN_STATES: Record<
	ReturnState,
	{ label: string; tone?: Tone }
> = {
	on_its_way: { label: "On its way", tone: "info" },
	requested: { label: "Requested", tone: "info" },
	refunded: { label: "Refunded, not back", tone: "warning" },
	maybe: { label: "Maybe coming back" },
};

const REQUEST_TONE: Record<
	OrderDetail["returnRequests"][number]["status"],
	Tone | undefined
> = {
	requested: "info",
	shipped: "info",
	delivered: "success",
	closed: undefined,
	cancelled: undefined,
};

// A Shopify condition handle as words: "new-previous-gen" → "New previous gen".
export const conditionName = (handle: string) =>
	handle.charAt(0).toUpperCase() + handle.slice(1).replace(/-/g, " ");

// The carrier's own page for a return's tracking, when the carrier is one
// katasync knows by name.
function trackingPage(carrier: string | null, number: string) {
	const c = carrier?.toLowerCase() ?? "";
	if (c.includes("usps"))
		return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${number}`;
	if (c.includes("fedex"))
		return `https://www.fedex.com/fedextrack/?trknbr=${number}`;
	if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${number}`;
	return null;
}

type Received = OrderDetail["returnsReceived"][number];

export function hasReturn(d: OrderDetail) {
	return (
		d.returnState !== null ||
		d.returnRequests.length > 0 ||
		d.returnsReceived.length > 0 ||
		d.order.noReturnAt !== null
	);
}

export function ReturnCard({
	detail: d,
	canReceive,
	onReceive,
	onNothing,
	onTakeBack,
}: {
	detail: OrderDetail;
	canReceive: boolean;
	onReceive: () => void;
	onNothing: () => void;
	onTakeBack: (r: Received) => void;
}) {
	const lines = new Map(d.lines.map((l) => [l.id, l]));
	const state = d.returnState ? RETURN_STATES[d.returnState] : null;
	const expected = d.expected.filter((e) => e.expected > 0);
	return (
		<Card
			title="Return"
			flush
			aside={
				state ? (
					<Badge tone={state.tone}>{state.label}</Badge>
				) : d.order.noReturnAt ? (
					<Badge>Nothing coming back</Badge>
				) : d.returnsReceived.length > 0 ? (
					<Badge tone="success">Received</Badge>
				) : undefined
			}
		>
			{expected.length > 0 && (
				<Section
					title={d.returnState === "maybe" ? "Could come back" : "Due back"}
				>
					<ul className="flex flex-col gap-2">
						{expected.map((e) => {
							const l = lines.get(e.lineId);
							return (
								<li key={e.lineId} className="flex items-center gap-3">
									<ProductImage src={l?.imageUrl ?? null} className="size-8" />
									<span className="min-w-0 flex-1 truncate">
										{l?.title ?? "A line no longer on the order"}
									</span>
									<span className="shrink-0 font-semibold tabular-nums">
										{d.returnState === "maybe" ? "up to " : ""}×{" "}
										{formatCount(e.expected)}
									</span>
								</li>
							);
						})}
					</ul>
				</Section>
			)}

			{d.returnRequests.map((r) => (
				<Section
					key={r.id}
					title={
						<span className="flex items-center gap-2">
							<Badge tone={REQUEST_TONE[r.status]}>
								{r.rawStatus.charAt(0).toUpperCase() +
									r.rawStatus.slice(1).toLowerCase().replace(/_/g, " ")}
							</Badge>
							<span>
								Opened {formatOrderDate(r.requestedAt)} on{" "}
								{channelName(r.billedBy)}
							</span>
							{r.page && (
								<a
									href={r.page.url}
									target="_blank"
									rel="noreferrer"
									className="ml-auto inline-flex items-center gap-1 font-normal text-link hover:underline"
								>
									Open on {r.page.name}
									<ExternalLink className="size-3" />
								</a>
							)}
						</span>
					}
				>
					<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
						{r.reason && (
							<>
								<dt className="text-muted-foreground">Reason</dt>
								<dd>{returnReason(r.reason)}</dd>
							</>
						)}
						{r.trackingNumber && (
							<>
								<dt className="text-muted-foreground">Tracking</dt>
								<dd className="truncate">
									<Tracking carrier={r.carrier} number={r.trackingNumber} />
								</dd>
							</>
						)}
						{r.lines.length > 0 && (
							<>
								<dt className="text-muted-foreground">Sending</dt>
								<dd>
									{r.lines
										.map(
											(l) =>
												`${formatCount(l.quantity)} × ${
													(l.orderLineId && lines.get(l.orderLineId)?.sku) ??
													l.sku ??
													"an item"
												}${l.orderLineId === null ? " (line unclear)" : ""}`,
										)
										.join(", ")}
								</dd>
							</>
						)}
					</dl>
					{r.note && (
						<blockquote className="mt-2 border-l-2 pl-3 text-muted-foreground">
							{r.note}
						</blockquote>
					)}
				</Section>
			))}

			{d.returnsReceived.length > 0 && (
				<Section title="Received">
					<ul className="flex flex-col gap-1.5">
						{d.returnsReceived.map((r) => {
							const l = lines.get(r.lineId);
							return (
								<li key={r.id} className="flex items-center gap-2">
									<span className="w-32 shrink-0 text-muted-foreground">
										{formatOrderDate(r.createdAt)}
									</span>
									<span className="min-w-0 flex-1 truncate">
										{formatCount(r.quantity)} × {l?.sku ?? l?.title}
									</span>
									<Outcome r={r} />
									{r.refurb && (
										<Tip content="Print its box label">
											<button
												type="button"
												aria-label="Print its box label"
												onClick={() =>
													printPdf(`/labels/refurbs/${r.id}`, "Box label")
												}
												className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-strong hover:text-foreground"
											>
												<Printer className="size-4" />
											</button>
										</Tip>
									)}
									{!r.preCutover && (
										<Tip content="Take this return back">
											<button
												type="button"
												aria-label="Take this return back"
												onClick={() => onTakeBack(r)}
												className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-strong hover:text-foreground"
											>
												<Undo2 className="size-4" />
											</button>
										</Tip>
									)}
								</li>
							);
						})}
					</ul>
				</Section>
			)}

			{(canReceive || d.returnState) && (
				<div className="flex gap-2 border-t px-4 py-3">
					{canReceive && (
						<Button size="sm" variant="outline" onClick={onReceive}>
							<Undo2 />
							Receive return
							<kbd className="ml-1 rounded bg-black/5 px-1 text-xs">R</kbd>
						</Button>
					)}
					{d.returnState && (
						<Button size="sm" variant="ghost" onClick={onNothing}>
							<Ban />
							Nothing coming back
						</Button>
					)}
				</div>
			)}
		</Card>
	);
}

function Section({
	title,
	children,
}: {
	title: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="border-t px-4 py-3 first:border-t-0">
			<div className="mb-2 text-xs font-medium text-muted-foreground">
				{title}
			</div>
			{children}
		</div>
	);
}

function Tracking({
	carrier,
	number,
}: {
	carrier: string | null;
	number: string;
}) {
	const page = trackingPage(carrier, number);
	const text = `${carrier ? `${carrier} ` : ""}${number}`;
	return page ? (
		<a
			href={page}
			target="_blank"
			rel="noreferrer"
			className="inline-flex items-center gap-1 font-mono text-link hover:underline"
		>
			{text}
			<ExternalLink className="size-3" />
		</a>
	) : (
		<span className="font-mono">{text}</span>
	);
}

function Outcome({ r }: { r: Received }) {
	if (r.refurb)
		return (
			<Badge tone="success">
				{conditionName(r.refurb.condition)} · {r.refurb.sku}
			</Badge>
		);
	if (r.preCutover) return <Badge>Before katasync</Badge>;
	return r.restocked ? (
		<Badge tone="success">Back on shelf</Badge>
	) : (
		<Badge>Written off</Badge>
	);
}
