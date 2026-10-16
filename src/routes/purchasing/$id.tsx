import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import {
	AlertTriangle,
	ArrowRight,
	FileText,
	Mail,
	Smartphone,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useNumberLine } from "#/components/number-line";
import { Badge, Banner, Card, Page } from "#/components/page";
import {
	ProductPicker,
	type PurchaseOrderMatch,
} from "#/components/po-product-picker";
import { ProductImage } from "#/components/product";
import { PurchaseUnitCell } from "#/components/purchase-unit";
import { StockRing } from "#/components/stock-ring";
import { SupplierDialog } from "#/components/supplier-dialog";
import { Button } from "#/components/ui/button";
import {
	cityLine,
	formatCount,
	formatDay,
	formatMoney,
	formatPhone,
	formatTime,
} from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";
import { purchaseOrderStatus } from "#/purchasing/status";
import {
	addProductToPurchaseOrder,
	amendPurchaseLine,
	cancelPurchaseOrder,
	closePurchaseOrder,
	editDraft,
	getPurchaseOrder,
	moveSetPart,
	type PurchaseOrderDetail,
	receiveLine,
	sendPurchaseOrder,
	setLine,
	setProductSupplier,
	setPurchaseLineTerms,
	undoPurchaseReceipt,
	updateDraftFromSuggestions,
} from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/$id")({
	loader: ({ params }) => getPurchaseOrder({ data: { id: Number(params.id) } }),
	component: PurchaseOrderPage,
});

const errorText = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

// Runs a change, reports failures, and reloads the page's data. Resolves to
// { value } on success and null on failure, since many changes return nothing.
function useAction() {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	async function run<T>(fn: () => Promise<T>, success?: (r: T) => string) {
		setBusy(true);
		try {
			const result = await fn();
			await router.invalidate();
			if (success) toast.success(success(result));
			return { value: result };
		} catch (err) {
			toast.error(errorText(err));
			return null;
		} finally {
			setBusy(false);
		}
	}
	return { busy, run };
}

function PurchaseOrderPage() {
	const d = Route.useLoaderData();
	const navigate = useNavigate();
	const { busy, run } = useAction();
	const po = d.order;
	const draft = po.status === "draft";
	// Sent and closed POs can still change, without telling the supplier.
	const editable = po.status !== "cancelled";
	const [editingSupplier, setEditingSupplier] = useState(false);
	const picker = useRef<HTMLInputElement>(null);
	// The line just added or picked, so it scrolls into view with its
	// quantity open. The nonce reopens it when picked again.
	const [focus, setFocus] = useState<LineFocus | null>(null);
	// Counted in the product itself, so 2 cases of 12 are 24.
	const ordered = d.lines.reduce((n, l) => n + l.quantity * l.packSize, 0);
	const received = d.lines.reduce(
		(n, l) => n + Math.min(l.received, l.quantity) * l.packSize,
		0,
	);
	const status = purchaseOrderStatus({ ...po, ordered, received });
	const total = d.lines.reduce((n, l) => n + l.quantity * (l.unitCost ?? 0), 0);
	// Tool sets are priced as their parts when sent, so they're counted apart.
	const sets = d.lines.filter((l) => l.kind === "bundle").length;
	const unpriced = d.lines.filter(
		(l) => l.unitCost === null && l.kind !== "bundle",
	).length;
	const canEmail = d.emailConfigured && Boolean(d.supplier.email);
	const wasSent = po.sentAt !== null;
	const changed = d.lines.filter((l) => changedSinceSent(l, wasSent)).length;
	const sentTotal = d.lines.reduce(
		(n, l) => n + (l.sentQuantity ?? 0) * (l.sentUnitCost ?? 0),
		0,
	);
	const incoming = d.lines.filter((l) => l.received < l.quantity);
	// Lines with none coming sit last, under what did arrive.
	const arrived = d.lines
		.filter((l) => l.received >= l.quantity)
		.sort((a, b) => Number(a.quantity === 0) - Number(b.quantity === 0));
	const lineTable = (lines: Line[]) => (
		<LineTable
			detail={d}
			lines={lines}
			focus={focus}
			onQuantityDone={(enter) => {
				setFocus(null);
				if (enter) picker.current?.focus();
			}}
		/>
	);
	const totals = (
		<>
			{editable && (
				<ProductPicker
					ref={picker}
					purchaseOrderId={po.id}
					sent={!draft}
					busy={busy}
					onPick={pick}
				/>
			)}
			<div className="flex items-center justify-end gap-6 border-t px-4 py-3">
				<span className="text-muted-foreground">
					{formatCount(ordered)} {ordered === 1 ? "unit" : "units"}
					{unpriced > 0 && `, ${unpriced} without a cost`}
					{sets > 0 &&
						`, plus ${sets === 1 ? "a set" : `${sets} sets`} priced as parts when sent`}
				</span>
				{changed > 0 && sentTotal !== total && (
					<span className="text-muted-foreground tabular-nums">
						Sent as {formatMoney(sentTotal)}
					</span>
				)}
				<span className="font-semibold tabular-nums">{formatMoney(total)}</span>
			</div>
		</>
	);

	useHotkeys({
		Escape: () => navigate({ to: "/purchasing" }),
		"/": (e) => {
			if (!editable) return;
			e.preventDefault();
			picker.current?.focus();
		},
	});

	async function pick(m: PurchaseOrderMatch) {
		if (m.lineId !== null) {
			toast(`${m.sku} is already on this PO`);
			setFocus({ lineId: m.lineId, nonce: Date.now() });
			return true;
		}
		const r = await run(
			() =>
				addProductToPurchaseOrder({
					data: { purchaseOrderId: po.id, productId: m.productId },
				}),
			(r) =>
				!r.added
					? `${m.sku} is already on this PO`
					: draft
						? `Added ${m.sku}`
						: `Added ${m.sku}. The supplier isn't told.`,
		);
		if (!r) return false;
		setFocus({ lineId: r.value.lineId, nonce: Date.now() });
		return true;
	}

	const send = (email: boolean) =>
		run(
			() => sendPurchaseOrder({ data: { id: po.id, email } }),
			(r) =>
				r.sentTo
					? `PO ${po.id} emailed to ${r.sentTo}`
					: `PO ${po.id} is on order`,
		);

	return (
		<Page
			width="wide"
			back={{ to: "/purchasing" }}
			title={
				<span className="flex items-center gap-2">
					PO {po.id}
					<Badge tone={status.tone}>{status.label}</Badge>
				</span>
			}
			actions={
				<>
					{d.lines.length > 0 && (
						<Button asChild variant="outline" size="sm">
							<a
								href={`/purchasing/pdf/${po.id}`}
								target="_blank"
								rel="noreferrer"
								title={
									draft
										? undefined
										: "As sent to the supplier, without later changes"
								}
							>
								<FileText />
								PDF
							</a>
						</Button>
					)}
					{po.status === "sent" && (
						<Button asChild variant="outline" size="sm">
							<Link to="/receive/$id" params={{ id: String(po.id) }}>
								<Smartphone />
								Receive on phone
							</Link>
						</Button>
					)}
					{draft && (
						<Button
							size="sm"
							disabled={busy || d.lines.length === 0 || !canEmail}
							title={
								canEmail ? `Email the PDF to ${d.supplier.email}` : undefined
							}
							onClick={() => send(true)}
						>
							<Mail />
							Send to supplier
						</Button>
					)}
				</>
			}
		>
			{draft && !d.supplier.email && (
				<Banner
					tone="warning"
					title={`${d.supplier.name} has no email`}
					action={{
						label: "Add one",
						link: { to: "/purchasing/suppliers" },
					}}
				>
					Add one to email this PO, or order another way and mark it sent below.
				</Banner>
			)}
			{draft && d.supplier.email && !d.emailConfigured && (
				<Banner tone="warning" title="Email isn't set up">
					katasync needs RESEND_API_KEY and PO_EMAIL_FROM to send POs. Until
					then, download the PDF and mark it sent below.
				</Banner>
			)}

			{/* The lines need the width, so the side cards only sit beside them on
			    wide screens. */}
			<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
				<div className="flex min-w-0 flex-col gap-4">
					{draft ? (
						<Card flush>
							<FrozenBar detail={d} />
							{lineTable(d.lines)}
							{totals}
						</Card>
					) : (
						<>
							{changed > 0 && (
								<Banner
									tone="warning"
									title={`${changed === 1 ? "1 line" : `${formatCount(changed)} lines`} changed after sending`}
								>
									These stay here: the PDF and the supplier still have what was
									sent.
								</Banner>
							)}
							{/* Like Shopify's unfulfilled and fulfilled cards: a line moves
							    down once all of it is in. */}
							{incoming.length > 0 && (
								<Card
									flush
									title={po.status === "sent" ? "Incoming" : "Not received"}
									aside={`${incoming.length} ${incoming.length === 1 ? "line" : "lines"}`}
								>
									{lineTable(incoming)}
									{arrived.length === 0 && totals}
								</Card>
							)}
							{arrived.length > 0 && (
								<Card
									flush
									title="Received"
									aside={`${arrived.length} ${arrived.length === 1 ? "line" : "lines"}`}
								>
									{lineTable(arrived)}
									{totals}
								</Card>
							)}
							{d.lines.length === 0 && (
								<Card flush>
									{lineTable(d.lines)}
									{totals}
								</Card>
							)}
							<Timeline detail={d} />
						</>
					)}
				</div>

				<div className="flex flex-col gap-4">
					<Card
						title="Supplier"
						aside={
							<button
								type="button"
								onClick={() => setEditingSupplier(true)}
								className="text-link hover:underline"
							>
								Edit
							</button>
						}
					>
						<div className="flex flex-col gap-0.5">
							<span className="font-medium">{d.supplier.name}</span>
							{d.supplier.contactName && <span>{d.supplier.contactName}</span>}
							{d.supplier.email ? (
								<a
									href={`mailto:${d.supplier.email}`}
									className="truncate text-link hover:underline"
								>
									{d.supplier.email}
								</a>
							) : (
								<span className="text-muted-foreground">No email</span>
							)}
							{d.supplier.phone && <span>{formatPhone(d.supplier.phone)}</span>}
							{d.supplier.paymentTerms && (
								<span className="text-muted-foreground">
									Terms: {d.supplier.paymentTerms}
								</span>
							)}
							{d.supplier.notes && (
								<p className="mt-2 rounded-lg bg-subtle px-2 py-1.5">
									{d.supplier.notes}
								</p>
							)}
						</div>
					</Card>
					<SupplierDialog
						supplier={d.supplier}
						open={editingSupplier}
						onOpenChange={setEditingSupplier}
					/>

					<Card title="Delivery">
						<div className="flex flex-col gap-2">
							{draft && d.locations.length > 1 ? (
								<select
									value={po.locationId}
									disabled={busy}
									onChange={(e) =>
										run(() =>
											editDraft({
												data: {
													purchaseOrderId: po.id,
													locationId: Number(e.target.value),
												},
											}),
										)
									}
									className="h-8 rounded-lg border border-input px-2"
								>
									{d.locations.map((l) => (
										<option key={l.id} value={l.id}>
											{l.name}
										</option>
									))}
								</select>
							) : (
								<div>
									<div className="font-medium">{d.location.name}</div>
									<div className="text-muted-foreground">
										{cityLine(
											d.location.city,
											d.location.region,
											d.location.postalCode,
										)}
									</div>
								</div>
							)}
							<Dates detail={d} />
						</div>
					</Card>

					<Card title="Notes on this PO">
						{draft ? (
							<textarea
								defaultValue={po.notes ?? ""}
								placeholder="Printed on the PO, e.g. ship by ground"
								rows={3}
								onBlur={(e) =>
									e.target.value !== (po.notes ?? "") &&
									run(() =>
										editDraft({
											data: { purchaseOrderId: po.id, notes: e.target.value },
										}),
									)
								}
								className="w-full rounded-lg border border-input px-2 py-1.5 outline-none focus:border-ring"
							/>
						) : (
							<p className={cn(!po.notes && "text-muted-foreground")}>
								{po.notes ?? "None"}
							</p>
						)}
						{d.supplier.poNotes && (
							<p className="mt-2 text-muted-foreground">
								Also printed for every {d.supplier.name} PO:{" "}
								{d.supplier.poNotes}
							</p>
						)}
					</Card>

					<OtherActions
						detail={d}
						received={received}
						onSent={() => send(false)}
						busy={busy}
						run={run}
					/>
				</div>
			</div>
		</Page>
	);
}

function Dates({ detail: d }: { detail: PurchaseOrderDetail }) {
	const po = d.order;
	const rows: [string, ReactNode][] = [["Created", formatDay(po.createdAt)]];
	if (po.sentAt)
		rows.push([
			"Sent",
			<span key="sent">
				{formatDay(po.sentAt)}
				{po.sentTo && (
					<span className="text-muted-foreground"> to {po.sentTo}</span>
				)}
			</span>,
		]);
	if (po.expectedAt && po.status === "sent")
		rows.push(["Expected", formatDay(po.expectedAt)]);
	if (po.closedAt)
		rows.push([
			po.status === "cancelled" ? "Cancelled" : "Closed",
			formatDay(po.closedAt),
		]);
	if (po.status === "draft")
		rows.push([
			"Lead time",
			`${d.supplier.leadTimeDays} days, so about ${formatDay(new Date(Date.now() + d.supplier.leadTimeDays * 86_400_000))}`,
		]);
	return (
		<dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-y-1">
			{rows.map(([label, value]) => (
				<div key={label} className="contents">
					<dt className="text-muted-foreground">{label}</dt>
					<dd className="min-w-0 truncate">{value}</dd>
				</div>
			))}
		</dl>
	);
}

// A draft doesn't change by itself after it's made. When today's
// suggestions have moved on, this says how, and Update brings them in: new
// products added, short quantities raised. Nothing is lowered.
function FrozenBar({ detail: d }: { detail: PurchaseOrderDetail }) {
	const { busy, run } = useAction();
	const { added, raised } = d.changes;
	if (added + raised === 0) return null;
	const parts = [
		added > 0 && `${formatCount(added)} new`,
		raised > 0 &&
			`${formatCount(raised)} ${raised === 1 ? "needs" : "need"} more`,
	].filter(Boolean);
	return (
		<div className="flex items-center gap-3 border-b bg-info-surface px-4 py-2.5">
			<p className="min-w-0 flex-1">
				<span className="font-medium">
					Reorder needs changed: {parts.join(", ")}.
				</span>{" "}
				<span className="text-muted-foreground">
					This draft stays as it is until you update it.
				</span>
			</p>
			<Button
				size="sm"
				variant="outline"
				disabled={busy}
				onClick={() =>
					run(
						() => updateDraftFromSuggestions({ data: { id: d.order.id } }),
						(r) =>
							r.added + r.raised === 0
								? "Already up to date"
								: [
										r.added > 0 && `added ${r.added}`,
										r.raised > 0 && `raised ${r.raised}`,
									]
										.filter(Boolean)
										.join(" and ")
										.replace(/^./, (c) => c.toUpperCase()),
					)
				}
			>
				Update
			</Button>
		</div>
	);
}

type Line = PurchaseOrderDetail["lines"][number];

type LineFocus = { lineId: number; nonce: number };

// A line that differs from what the supplier was sent, or was added after.
// A draft has sent nothing, so nothing on it has changed.
function changedSinceSent(l: Line, sent: boolean) {
	return (
		sent &&
		(l.sentQuantity === null ||
			l.quantity !== l.sentQuantity ||
			l.unitCost !== l.sentUnitCost)
	);
}

// A quantity being dragged, typed, or saved, before the page's data has it.
type QuantityPreview = { lineId: number; quantity: number };

function LineTable({
	detail: d,
	lines,
	focus,
	onQuantityDone,
}: {
	detail: PurchaseOrderDetail;
	lines: Line[];
	focus: LineFocus | null;
	// A quantity opened by focus is done; enter says it was left with Enter.
	onQuantityDone: (enter: boolean) => void;
}) {
	const draft = d.order.status === "draft";
	const receiving = d.order.status === "sent";
	const editable = d.order.status !== "cancelled";
	const wasSent = d.order.sentAt !== null;
	// The focused line scrolls into view.
	const focusedRow = useRef<HTMLTableRowElement>(null);
	useEffect(() => {
		if (focus) focusedRow.current?.scrollIntoView({ block: "nearest" });
	}, [focus]);
	const [preview, setPreview] = useState<QuantityPreview | null>(null);
	// Each line only sets or clears its own preview.
	const previewFor = (lineId: number) => (quantity: number | null) =>
		setPreview((prev) =>
			quantity === null
				? prev?.lineId === lineId
					? null
					: prev
				: { lineId, quantity },
		);
	if (lines.length === 0)
		return (
			<p className="px-4 py-6 text-center text-muted-foreground">
				{draft
					? "Nothing on this PO yet. Add a product below."
					: "Nothing on this PO."}
			</p>
		);
	return (
		// Scrolls sideways rather than squeeze a column when there's no room.
		<div className="overflow-x-auto">
			{/* After sending, lines split across the Incoming and Received cards;
			    fixed widths keep their columns lined up. */}
			<table
				className={cn(
					"w-full [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap",
					!draft && "min-w-[54rem] table-fixed",
				)}
			>
				{!draft && (
					<colgroup>
						<col />
						<col className="w-24" />
						<col className="w-24" />
						<col className="w-24" />
						<col className="w-24" />
						<col className="w-24" />
						<col className="w-56" />
					</colgroup>
				)}
				<thead>
					<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium">Product</th>
						<th className="px-3 py-2 font-medium whitespace-nowrap">
							Their SKU
						</th>
						<th className="px-3 py-2 font-medium whitespace-nowrap">
							MOQ / UOM
						</th>
						<th className="px-3 py-2 text-right font-medium">Qty</th>
						{draft && (
							<th className="px-3 py-2 text-center font-medium whitespace-nowrap">
								On hand → After PO
							</th>
						)}
						<th className="px-3 py-2 text-right font-medium">Cost</th>
						<th className="px-4 py-2 text-right font-medium">Amount</th>
						{!draft && (
							<th className="px-4 py-2 text-right font-medium">Received</th>
						)}
					</tr>
				</thead>
				<tbody>
					{lines.map((l) => (
						<Fragment key={l.id}>
							<tr
								ref={focus?.lineId === l.id ? focusedRow : undefined}
								className={cn(
									"border-t transition-colors first:border-t-0",
									focus?.lineId === l.id && "bg-info-surface",
									// Nothing is coming: kept to show the supplier didn't send it.
									l.quantity === 0 &&
										l.received === 0 &&
										"text-muted-foreground",
								)}
							>
								<td className="w-full px-4 py-2 whitespace-normal!">
									<div
										className={cn(
											"flex items-center gap-3",
											draft && "min-w-72",
										)}
									>
										<ProductImage src={l.imageUrl} />
										<div className="min-w-0">
											<Link
												to="/products/$sku"
												params={{ sku: l.sku }}
												className="block hover:underline"
											>
												{/* Wraps instead of cutting off: on a PO the full name matters. */}
												<span className="line-clamp-2 font-medium">
													{l.name}
													{l.variantName && (
														<span className="ml-1.5 rounded-md bg-surface px-1.5 text-xs font-normal text-muted-foreground">
															{l.variantName}
														</span>
													)}
												</span>
											</Link>
											<div className="text-xs text-muted-foreground">
												{l.sku}
												{l.kind === "bundle" && " · Set, sent as its parts"}
												{wasSent && l.sentQuantity === null && (
													<span className="text-warning-text">
														{" "}
														· Added after sending
													</span>
												)}
											</div>
										</div>
									</div>
								</td>
								<td className="px-3 py-2">
									<SupplierSkuField line={l} supplierId={d.supplier.id} />
								</td>
								<td className="px-3 py-2">
									<PurchaseUnitCell
										label={l.sku}
										value={l}
										cost={l.unitCost}
										units={draft ? d.units : undefined}
										saving={{
											save: (terms) =>
												setPurchaseLineTerms({
													data: {
														purchaseOrderId: d.order.id,
														productId: l.productId,
														...terms,
														makeDefault: false,
													},
												}),
											// Only the product's own supplier's terms can change here.
											...(l.linkSupplierId === d.supplier.id
												? {
														current: {
															unit: l.defaultUnit ?? "EACH",
															packSize: l.defaultPackSize ?? 1,
															minimumQuantity: l.defaultMinimum ?? 1,
														},
														saveDefault: (terms) =>
															setPurchaseLineTerms({
																data: {
																	purchaseOrderId: d.order.id,
																	productId: l.productId,
																	...terms,
																	makeDefault: true,
																},
															}),
													}
												: {
														noDefaultReason:
															l.linkSupplierId === null
																? "This product has no supplier yet; set one on its page"
																: "This product is bought from another supplier",
													}),
										}}
									/>
								</td>
								<td className="px-3 py-2 text-right font-semibold tabular-nums">
									{editable ? (
										<QuantityField
											key={`q${l.quantity}`}
											line={l}
											purchaseOrderId={d.order.id}
											draft={draft}
											open={focus?.lineId === l.id ? focus.nonce : null}
											onDone={onQuantityDone}
											onPreview={previewFor(l.id)}
										/>
									) : (
										formatCount(l.quantity)
									)}
									<WasSent
										line={l}
										shows={l.sentQuantity !== l.quantity}
										text={`sent ${formatCount(l.sentQuantity ?? 0)}`}
									/>
								</td>
								{draft && (
									<td className="px-3 py-2">
										{l.kind === "bundle" || !l.stockRange ? (
											<span className="block text-center text-muted-foreground">
												—
											</span>
										) : (
											<div className="flex items-center justify-center gap-1">
												<StockRing onHand={l.onHand} range={l.stockRange} />
												<ArrowRight
													className="size-4 text-muted-foreground"
													strokeWidth={2.5}
													aria-hidden="true"
												/>
												<StockRing
													onHand={
														l.onHand +
														(preview?.lineId === l.id
															? preview.quantity
															: l.quantity) *
															l.packSize
													}
													range={l.stockRange}
													label="after this PO"
												/>
											</div>
										)}
									</td>
								)}
								<td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
									{l.kind === "bundle" ? (
										<span className="text-muted-foreground">As parts</span>
									) : editable ? (
										<PriceField
											line={l}
											purchaseOrderId={d.order.id}
											draft={draft}
										/>
									) : (
										formatMoney(l.unitCost)
									)}
									<WasSent
										line={l}
										shows={l.sentUnitCost !== l.unitCost}
										text={`sent ${formatMoney(l.sentUnitCost)}`}
									/>
								</td>
								<td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">
									{l.unitCost === null
										? "—"
										: formatMoney(l.unitCost * l.quantity)}
								</td>
								{!draft && (
									<td className="px-4 py-2 text-right whitespace-nowrap">
										{l.quantity === 0 && l.received === 0 ? (
											<Badge>None coming</Badge>
										) : receiving && l.received < l.quantity ? (
											<ReceiveField line={l} />
										) : (
											<Badge
												tone={l.received >= l.quantity ? "success" : undefined}
											>
												{formatCount(l.received)} of {formatCount(l.quantity)}
											</Badge>
										)}
									</td>
								)}
							</tr>
							{l.kind === "bundle" && <SetParts detail={d} line={l} />}
						</Fragment>
					))}
				</tbody>
			</table>
		</div>
	);
}

// Under a sent line's quantity or cost, when it has changed since: what the
// supplier was sent, which is what the PDF still shows.
function WasSent({
	line,
	shows,
	text,
}: {
	line: Line;
	shows: boolean;
	text: string;
}) {
	if (line.sentQuantity === null || !shows) return null;
	return (
		<div
			className="text-xs font-normal text-warning-text"
			title="What the supplier was sent. The PDF still shows this."
		>
			{text}
		</div>
	);
}

// A set's parts, under its line on a draft. Sending puts them on this PO,
// except parts moved to their own supplier's draft. A part bought from
// another supplier is flagged with a button to move it there.
function SetParts({
	detail: d,
	line,
}: {
	detail: PurchaseOrderDetail;
	line: Line;
}) {
	const { busy, run } = useAction();
	return d.setParts
		.filter((p) => p.lineId === line.id)
		.map((p) => {
			const elsewhere =
				!p.moved && p.supplierId !== null && p.supplierId !== d.supplier.id;
			const units = Math.ceil(p.items / p.packSize);
			const extra = units * p.packSize - p.items;
			return (
				<tr key={p.productId} className="text-xs">
					<td className="max-w-0 py-1 pr-4 pl-[4.25rem]">
						<div
							className={cn(
								"truncate",
								p.moved && "line-through text-muted-foreground",
							)}
						>
							{p.name}
							{p.variantName && ` (${p.variantName})`}
							<span className="text-muted-foreground"> · {p.sku}</span>
						</div>
						{p.moved ? (
							<div className="text-muted-foreground">
								Moved to {p.supplierName}'s draft
							</div>
						) : elsewhere ? (
							<div className="flex items-center gap-2 text-warning-text">
								<AlertTriangle className="size-3.5 shrink-0" />
								Bought from {p.supplierName}
								<Button
									size="sm"
									variant="outline"
									className="h-6 px-2 text-xs"
									disabled={busy}
									onClick={() =>
										run(
											() =>
												moveSetPart({
													data: { lineId: line.id, productId: p.productId },
												}),
											(po) => `Moved ${p.sku} to PO ${po}`,
										)
									}
								>
									Move to {p.supplierName}
								</Button>
							</div>
						) : (
							p.supplierId === null && (
								<div className="flex items-center gap-2 text-warning-text">
									<AlertTriangle className="size-3.5 shrink-0" />
									No supplier yet; set one on its page
								</div>
							)
						)}
					</td>
					<td
						colSpan={6}
						className="px-4 py-1 text-right text-muted-foreground tabular-nums"
					>
						{!p.moved && (
							<>
								{formatCount(p.items)} needed
								{p.packSize > 1 &&
									`, adds ${formatCount(units)} ${p.unit} of ${p.packSize}${extra > 0 ? ` (${formatCount(extra)} extra)` : ""}`}
							</>
						)}
					</td>
				</tr>
			);
		});
}

const field =
	"h-8 rounded-lg border border-input bg-white px-2 text-right tabular-nums outline-none focus:border-ring";

// Quantity reads as a bold number on a soft fill, so the column scans at a
// glance.
const quantityBox =
	"h-9 w-16 rounded-lg border border-transparent bg-surface px-2 text-right text-[0.9375rem] font-semibold tabular-nums outline-none";

// A line's quantity. Click to type a number, or drag sideways for the
// number line. On a draft 0 takes the line off, with Undo. On a sent PO it's
// a change the supplier isn't told about, also with Undo; 0 there means none
// are coming.
// onPreview gets the quantity while it's dragged, typed, or saving, and null
// once the page shows the real one. `open` (a nonce) opens it for typing, and
// finishing calls onDone.
function QuantityField({
	line,
	purchaseOrderId,
	draft,
	open,
	onDone,
	onPreview,
}: {
	line: Line;
	purchaseOrderId: number;
	draft: boolean;
	open: number | null;
	// enter: it was left with Enter, so go on to the next product.
	onDone: (enter: boolean) => void;
	onPreview: (quantity: number | null) => void;
}) {
	const { run } = useAction();
	const router = useRouter();
	const [typing, setTyping] = useState(false);
	const [text, setText] = useState("");
	const [saving, setSaving] = useState<number | null>(null);
	// Opened by `open`, so Enter goes on to the next product.
	const opened = useRef(false);
	useEffect(() => {
		if (open === null) return;
		opened.current = true;
		setText("");
		setTyping(true);
	}, [open]);

	async function save(quantity: number) {
		if (quantity === line.quantity) return;
		setSaving(quantity);
		if (!draft) {
			const r = await run(() =>
				amendPurchaseLine({ data: { lineId: line.id, quantity } }),
			);
			setSaving(null);
			if (r)
				amended({
					line,
					result: r.value,
					summary: `${line.sku} now ${formatCount(quantity)}, was ${formatCount(line.quantity)}`,
					purchaseOrderId,
					reload: () => router.invalidate(),
				});
			return;
		}
		// run resolves after the page reloads, so the real quantity is in.
		const r = await run(() =>
			setLine({
				data: { purchaseOrderId, productId: line.productId, quantity },
			}),
		);
		setSaving(null);
		if (r && quantity === 0)
			toast(`Took ${line.sku} off this PO`, {
				action: {
					label: "Undo",
					onClick: async () => {
						await setLine({
							data: {
								purchaseOrderId,
								productId: line.productId,
								quantity: line.quantity,
								unitCost: line.unitCost,
							},
						});
						router.invalidate();
					},
				},
			});
	}

	const scrub = useNumberLine({ value: line.quantity, onCommit: save });

	const typed = text.trim();
	const previewing = scrub.dragging
		? scrub.shown
		: typing && /^\d+$/.test(typed)
			? Number(typed)
			: saving;
	// A ref, so a new callback each render doesn't re-run the effect.
	const report = useRef(onPreview);
	report.current = onPreview;
	useEffect(() => {
		report.current(previewing);
		return () => report.current(null);
	}, [previewing]);

	// Set by Enter just before it leaves the field.
	const entered = useRef(false);
	function finishTyping() {
		setTyping(false);
		// Once done, `open` must not reopen it when the saved quantity
		// remounts the field.
		if (opened.current) onDone(entered.current);
		entered.current = false;
		opened.current = false;
		const value = text.trim();
		if (value === "") return;
		const n = Number(value);
		if (!Number.isInteger(n) || n < 0) {
			toast.error(`"${value}" isn't a whole number`);
			return;
		}
		save(n);
	}

	if (typing)
		return (
			<input
				value={text}
				// biome-ignore lint/a11y/noAutofocus: opened by a click to type
				autoFocus
				inputMode="numeric"
				placeholder={String(line.quantity)}
				aria-label={`Quantity of ${line.sku}`}
				onChange={(e) => setText(e.target.value)}
				onBlur={finishTyping}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						entered.current = true;
						e.currentTarget.blur();
					}
					if (e.key === "Escape") {
						setText("");
						e.stopPropagation();
						e.currentTarget.blur();
					}
				}}
				className={cn(quantityBox, "border-ring bg-white")}
			/>
		);

	return (
		<>
			<button
				type="button"
				aria-label={`Quantity of ${line.sku}: ${line.quantity}`}
				title="Click to type, or drag sideways"
				{...scrub.handlers}
				onClick={() => {
					// A drag's release isn't a click.
					if (scrub.wasDrag()) return;
					setText("");
					setTyping(true);
				}}
				className={cn(
					quantityBox,
					"cursor-pointer select-none hover:bg-surface",
					scrub.dragging && "cursor-ew-resize",
				)}
			>
				{scrub.dragging ? scrub.shown : (saving ?? line.quantity)}
			</button>
			{scrub.line}
		</>
	);
}

// Reads as text with a dotted underline, like everything else that can be
// changed, until clicked. Its box is a fixed size either way, so editing
// doesn't push the columns around. Saves on Enter or leaving the field;
// Escape puts the old text back. Shows what was typed until the saved value
// comes back.
function InlineField({
	shown,
	initial,
	placeholder,
	label,
	inputMode,
	align = "left",
	className,
	onSave,
}: {
	// What it reads as when not being edited, e.g. "$12.50".
	shown: string;
	// What editing starts from, e.g. "12.50". Empty when there's nothing yet.
	initial: string;
	placeholder: string;
	label: string;
	inputMode?: "decimal" | "text";
	align?: "left" | "right";
	// Sets the width.
	className: string;
	// Resolves to false when the value wasn't saved.
	onSave: (text: string) => Promise<boolean>;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(initial);
	const [pending, setPending] = useState<string | null>(null);
	const cancelled = useRef(false);
	// A fresh value from the server ends any pending one.
	const [lastInitial, setLastInitial] = useState(initial);
	if (initial !== lastInitial) {
		setLastInitial(initial);
		setPending(null);
	}

	async function finish() {
		setEditing(false);
		const text = value.trim();
		if (cancelled.current || text === initial) {
			cancelled.current = false;
			return;
		}
		setPending(text);
		if (!(await onSave(text))) setPending(null);
	}

	const text = pending ?? (initial === "" ? "" : shown);
	return (
		<span
			className={cn(
				"relative inline-flex h-8 items-center px-1.5 align-middle",
				align === "right" && "justify-end",
				className,
			)}
		>
			{editing ? (
				<input
					value={value}
					// biome-ignore lint/a11y/noAutofocus: opened by a click to type
					autoFocus
					onFocus={(e) => e.currentTarget.select()}
					placeholder={placeholder}
					aria-label={label}
					inputMode={inputMode}
					onChange={(e) => setValue(e.target.value)}
					onBlur={finish}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							cancelled.current = true;
							e.stopPropagation();
							e.currentTarget.blur();
						}
					}}
					className={cn(
						"absolute inset-0 w-full rounded-md border border-ring bg-white px-[5px] tabular-nums outline-none",
						align === "right" && "text-right",
					)}
				/>
			) : (
				<button
					type="button"
					aria-label={label}
					onClick={() => {
						setValue(pending ?? initial);
						setEditing(true);
					}}
					className={cn(
						"max-w-full cursor-text truncate border-b border-dotted border-faint leading-tight tabular-nums hover:border-foreground",
						text === "" && "text-muted-foreground",
					)}
				>
					{text === "" ? placeholder : text}
				</button>
			)}
		</span>
	);
}

// Says what a change to a sent line did, that the supplier isn't told, and
// offers to put it back. A line added after sending and set to 0 comes off,
// so its undo adds it again.
function amended({
	line,
	result,
	summary,
	purchaseOrderId,
	reload,
}: {
	line: Line;
	result: Awaited<ReturnType<typeof amendPurchaseLine>>;
	summary: string;
	purchaseOrderId: number;
	reload: () => Promise<void>;
}) {
	const { was } = result;
	const undo = async () => {
		try {
			const lineId = result.removed
				? (
						await addProductToPurchaseOrder({
							data: { purchaseOrderId, productId: line.productId },
						})
					).lineId
				: line.id;
			await amendPurchaseLine({
				data: { lineId, quantity: was.quantity, unitCost: was.unitCost },
			});
		} catch (err) {
			toast.error(errorText(err));
		}
		await reload();
	};
	const action = { label: "Undo", onClick: undo };
	if (result.removed)
		toast(`Took ${line.sku} off. The supplier isn't told.`, { action });
	else if (result.receivedAtOldCost)
		toast.warning(
			`${summary}. What already arrived keeps the old cost. The supplier isn't told.`,
			{ action, duration: 10_000 },
		);
	else toast(`${summary}. The supplier isn't told.`, { action });
}

// A line's cost per unit. Empty means no cost yet. On a sent PO it's a change
// the supplier isn't told about.
function PriceField({
	line,
	purchaseOrderId,
	draft,
}: {
	line: Line;
	purchaseOrderId: number;
	draft: boolean;
}) {
	const { run } = useAction();
	const router = useRouter();
	return (
		<InlineField
			shown={formatMoney(line.unitCost)}
			initial={line.unitCost?.toFixed(2) ?? ""}
			placeholder="Add cost"
			label={`Cost of ${line.sku}`}
			inputMode="decimal"
			align="right"
			className="w-24"
			onSave={async (text) => {
				const n = Number(text.replace(/^\$/, ""));
				if (text !== "" && !(Number.isFinite(n) && n >= 0)) {
					toast.error(`"${text}" isn't a cost`);
					return false;
				}
				const unitCost = text === "" ? null : n;
				if (!draft) {
					const r = await run(() =>
						amendPurchaseLine({ data: { lineId: line.id, unitCost } }),
					);
					if (r)
						amended({
							line,
							result: r.value,
							summary: `${line.sku} now ${formatMoney(unitCost)}, was ${formatMoney(line.unitCost)}`,
							purchaseOrderId,
							reload: () => router.invalidate(),
						});
					return r !== null;
				}
				const r = await run(() =>
					setLine({
						data: {
							purchaseOrderId,
							productId: line.productId,
							quantity: line.quantity,
							unitCost,
						},
					}),
				);
				return r !== null;
			}}
		/>
	);
}

// The supplier's part number for the product, kept on the product, so it
// changes every PO with it. Only this PO's supplier's number can change here.
function SupplierSkuField({
	line,
	supplierId,
}: {
	line: Line;
	supplierId: number;
}) {
	const { run } = useAction();
	if (line.linkSupplierId !== supplierId)
		return (
			<span
				className="px-1.5 text-muted-foreground"
				title={
					line.kind === "bundle"
						? "Sets are bought as their parts"
						: line.linkSupplierId === null
							? "This product has no supplier yet; set one on its page"
							: "This product is bought from another supplier"
				}
			>
				{line.supplierSku ?? "—"}
			</span>
		);
	return (
		<InlineField
			shown={line.supplierSku ?? ""}
			initial={line.supplierSku ?? ""}
			placeholder="Add"
			label={`${line.sku}'s supplier SKU`}
			className="w-32"
			onSave={async (text) => {
				const r = await run(() =>
					setProductSupplier({
						data: {
							productId: line.productId,
							supplierId,
							supplierSku: text === "" ? null : text,
						},
					}),
				);
				return r !== null;
			}}
		/>
	);
}

// Receive from the desk: the remaining count is filled in, so Enter takes
// all of it.
function ReceiveField({ line }: { line: Line }) {
	const { busy, run } = useAction();
	const remaining = line.quantity - line.received;
	const [value, setValue] = useState(String(remaining));
	const n = Number(value);
	const valid = Number.isInteger(n) && n > 0;

	async function submit() {
		if (!valid) return;
		const r = await run(
			() => receiveLine({ data: { lineId: line.id, quantity: n } }),
			() =>
				`Received ${formatCount(n)}${line.packSize === 1 ? "" : ` ${line.unit}`} × ${line.sku}`,
		);
		if (r) setValue(String(Math.max(remaining - n, 1)));
	}

	return (
		<form
			className="inline-flex items-center gap-1.5"
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			<span className="text-muted-foreground tabular-nums">
				{formatCount(line.received)} of {formatCount(line.quantity)}
			</span>
			<input
				value={value}
				inputMode="numeric"
				aria-label={`${line.unit} of ${line.sku} received`}
				onChange={(e) => setValue(e.target.value)}
				className={cn(field, "w-14")}
			/>
			<Button
				type="submit"
				size="sm"
				variant="outline"
				disabled={busy || !valid}
			>
				Receive
			</Button>
		</form>
	);
}

type Amendment = PurchaseOrderDetail["amendments"][number];

function amendmentText(a: Amendment, name: string) {
	const was = formatCount(a.quantityBefore ?? 0);
	const now = formatCount(a.quantityAfter ?? 0);
	switch (a.kind) {
		case "added":
			return `Added ${now} × ${name} after sending`;
		case "removed":
			return `Took ${name} off`;
		case "quantity":
			return a.quantityAfter === 0
				? `None of ${name} coming, was ${was}`
				: `${name} changed from ${was} to ${now}`;
		case "cost":
			return `${name} cost changed from ${formatMoney(a.unitCostBefore)} to ${formatMoney(a.unitCostAfter)}`;
	}
}

// Marks a timeline entry as a change kept here, never sent.
function NotSent({ children }: { children: ReactNode }) {
	return <span className="text-warning-text"> · {children}</span>;
}

type TimelineEvent = {
	key: string;
	at: Date;
	body: ReactNode;
	undo?: PurchaseOrderDetail["receipts"][number];
};

// Everything that happened to the PO, newest first and grouped by day, like
// the timeline under a Shopify order. Receipts can be undone from here.
function Timeline({ detail: d }: { detail: PurchaseOrderDetail }) {
	const { busy, run } = useAction();
	const po = d.order;
	const lines = new Map(d.lines.map((l) => [l.id, l]));
	const events: TimelineEvent[] = [
		{ key: "created", at: new Date(po.createdAt), body: "PO created" },
	];
	if (po.sentAt)
		events.push({
			key: "sent",
			at: new Date(po.sentAt),
			body: po.sentTo ? `Sent to ${po.sentTo}` : "Marked as ordered",
		});
	for (const r of d.receipts) {
		const line = lines.get(r.lineId);
		events.push({
			key: `r${r.id}`,
			at: new Date(r.createdAt),
			undo: r,
			body: (
				<>
					Received{" "}
					<span className="font-semibold tabular-nums">
						{formatCount(r.quantity)}
					</span>
					{line && line.packSize !== 1 && ` ${line.unit}`} × {line?.name ?? "?"}
					{line?.variantName && (
						<span className="text-muted-foreground"> {line.variantName}</span>
					)}
					{r.quantityBefore !== null && r.quantityAfter !== null && (
						<NotSent>
							{r.quantityBefore === 0
								? "not on the PO, added"
								: r.quantityAfter > r.quantityBefore
									? `more than the ${formatCount(r.quantityBefore)} expected, kept`
									: `that's all they sent, of ${formatCount(r.quantityBefore)}`}
						</NotSent>
					)}
				</>
			),
		});
	}
	for (const a of d.amendments) {
		const name = a.variantName ? `${a.name} (${a.variantName})` : a.name;
		events.push({
			key: `a${a.id}`,
			at: new Date(a.createdAt),
			body: (
				<>
					{amendmentText(a, name)}
					<NotSent>supplier not told</NotSent>
				</>
			),
		});
	}
	if (po.closedAt)
		events.push({
			key: "closed",
			at: new Date(po.closedAt),
			body: po.status === "cancelled" ? "PO cancelled" : "PO closed",
		});
	events.sort((a, b) => b.at.getTime() - a.at.getTime());

	const days: { day: string; events: TimelineEvent[] }[] = [];
	for (const e of events) {
		const day = formatDay(e.at);
		if (days.at(-1)?.day !== day) days.push({ day, events: [] });
		days.at(-1)?.events.push(e);
	}

	return (
		<section>
			<h2 className="px-1 pb-2 text-sm font-semibold">Timeline</h2>
			<ol className="relative ml-3 border-l-2 border-border pb-1">
				{days.map((g) => (
					<li key={g.day}>
						<div className="py-2 pl-6 text-xs font-medium text-muted-foreground">
							{g.day}
						</div>
						<ul>
							{g.events.map((e) => {
								const receipt = e.undo;
								const line = receipt && lines.get(receipt.lineId);
								return (
									<li
										key={e.key}
										className="relative flex min-h-9 items-center gap-3 py-1 pl-6"
									>
										<span className="absolute top-1/2 -left-[7px] size-3 -translate-y-1/2 rounded-full border-2 border-background bg-muted-foreground/60" />
										<span className="min-w-0 flex-1">{e.body}</span>
										<span className="shrink-0 text-muted-foreground tabular-nums">
											{formatTime(e.at)}
										</span>
										{/* Always the same width, so the times line up. */}
										<span className="w-16 shrink-0 text-right">
											{receipt && (
												<Button
													size="sm"
													variant="ghost"
													disabled={busy}
													onClick={() =>
														run(
															() =>
																undoPurchaseReceipt({
																	data: { id: receipt.id },
																}),
															() =>
																`Took ${formatCount(receipt.quantity * (line?.packSize ?? 1))} back off the shelf`,
														)
													}
												>
													Undo
												</Button>
											)}
										</span>
									</li>
								);
							})}
						</ul>
					</li>
				))}
			</ol>
		</section>
	);
}

// The rarer moves, kept out of the header.
function OtherActions({
	detail: d,
	received,
	onSent,
	busy,
	run,
}: {
	detail: PurchaseOrderDetail;
	received: number;
	onSent: () => void;
	busy: boolean;
	run: ReturnType<typeof useAction>["run"];
}) {
	const navigate = useNavigate();
	const po = d.order;
	if (po.status === "closed" || po.status === "cancelled") return null;
	return (
		<Card title="More">
			<div className="flex flex-col items-start gap-1">
				{po.status === "draft" && (
					<Button
						variant="ghost"
						size="sm"
						disabled={busy || d.lines.length === 0}
						onClick={onSent}
					>
						Mark as sent
					</Button>
				)}
				{po.status === "sent" && received > 0 && (
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() =>
							confirm("Stop waiting for the rest of this PO?") &&
							run(
								() => closePurchaseOrder({ data: { id: po.id } }),
								() => `PO ${po.id} closed`,
							)
						}
					>
						Close, the rest isn't coming
					</Button>
				)}
				{received === 0 && (
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						className="text-critical-text"
						onClick={async () => {
							if (
								!confirm(
									po.status === "draft"
										? "Delete this draft?"
										: "Cancel this PO? Tell the supplier too.",
								)
							)
								return;
							const r = await run(
								() => cancelPurchaseOrder({ data: { id: po.id } }),
								() =>
									po.status === "draft"
										? "Draft deleted"
										: `PO ${po.id} cancelled`,
							);
							if (r) navigate({ to: "/purchasing" });
						}}
					>
						{po.status === "draft" ? "Delete draft" : "Cancel PO"}
					</Button>
				)}
			</div>
		</Card>
	);
}
