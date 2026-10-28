import { createFileRoute, Link } from "@tanstack/react-router";
import {
	FileText,
	Mail,
	PackageCheck,
	ShieldAlert,
	Smartphone,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	DamageDetailsDialog,
	damageName,
} from "#/components/damage/damage-details";
import {
	DamageDialog,
	type DamageTarget,
} from "#/components/damage/damage-dialog";
import { DamageReportDialog } from "#/components/damage/report-dialog";
import { Badge, Card, Page, useBack } from "#/components/page";
import { AddEmail } from "#/components/purchase-order/add-email";
import { AddItems } from "#/components/purchase-order/add-items";
import { ChargesRow } from "#/components/purchase-order/charges-row";
import { middayOf } from "#/components/purchase-order/days";
import { DeliveryCard } from "#/components/purchase-order/delivery-card";
import { FilesCard } from "#/components/purchase-order/files-card";
import { FlagsCard } from "#/components/purchase-order/flags";
import { InvoicesCard } from "#/components/purchase-order/invoices-card";
import { receiveAllWithUndo } from "#/components/purchase-order/line-actions";
import { damageable, lineName } from "#/components/purchase-order/line-damage";
import {
	type LineSort,
	LineTable,
} from "#/components/purchase-order/line-table";
import { NotesCard } from "#/components/purchase-order/notes-card";
import { OtherActions } from "#/components/purchase-order/other-actions";
import { PaymentsCard } from "#/components/purchase-order/payments-card";
import {
	draftTotals,
	isUnsent,
	poData,
	sinceSent,
} from "#/components/purchase-order/po-data";
import { ReorderBar } from "#/components/purchase-order/reorder-bar";
import { SendDialog } from "#/components/purchase-order/send-dialog";
import { SupplierPanel } from "#/components/purchase-order/supplier-panel";
import { Timeline } from "#/components/purchase-order/timeline";
import { TrackingCard } from "#/components/purchase-order/tracking-card";
import type { Line, LineFocus } from "#/components/purchase-order/types";
import { useAction } from "#/components/purchase-order/use-action";
import { PurchaseOrderSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatDay, formatMoney } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { lineCents } from "#/purchasing/discount";
import { purchaseOrderStatus, takenByReceiveAll } from "#/purchasing/status";
import { getPurchaseOrder, sendPurchaseOrder } from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/$id")({
	loader: ({ params }) => getPurchaseOrder({ data: { id: Number(params.id) } }),
	component: PurchaseOrderPage,
	pendingComponent: PurchaseOrderSkeleton,
});

function PurchaseOrderPage() {
	const loaded = Route.useLoaderData();
	const d = poData.useData(loaded.order.id, loaded);
	const goBack = useBack({ to: "/purchasing" });
	const { busy, run } = useAction();
	const po = d.order;
	// A suggested PO works like a draft; its first change makes it one.
	const draft = isUnsent(po.status);
	const suggested = po.status === "suggested";
	// Sent and closed POs can still change, without telling the supplier.
	const editable = po.status !== "cancelled";
	const [damageTarget, setDamageTarget] = useState<DamageTarget | null>(null);
	const [reportingDamage, setReportingDamage] = useState(false);
	const [composing, setComposing] = useState(false);
	const stopComposing = useCallback(() => setComposing(false), []);
	// Looked up by id, so it closes itself once the damage is removed.
	const [openDamageId, setOpenDamageId] = useState<number | null>(null);
	const openDamage = d.damages.find((x) => x.id === openDamageId);
	const unreported = d.damages.filter((x) => x.reportedAt === null);
	const picker = useRef<HTMLInputElement>(null);
	// The line just added or picked, so it scrolls into view with its
	// quantity open. The nonce reopens it when picked again.
	const [focus, setFocus] = useState<LineFocus | null>(null);
	const [lineSort, setLineSort] = useState<LineSort>([]);
	// Counted in the product itself, so 2 cases of 12 are 24.
	const ordered = d.lines.reduce((n, l) => n + l.quantity * l.packSize, 0);
	const received = d.lines.reduce(
		(n, l) => n + Math.min(l.received, l.quantity) * l.packSize,
		0,
	);
	const status = purchaseOrderStatus({
		...po,
		ordered,
		received,
		packages: {
			arrived: d.tracking.filter((t) => t.status === "DELIVERED").length,
			total: d.tracking.length,
		},
	});
	const shown = draft
		? draftTotals(d)
		: {
				units: ordered,
				total:
					d.lines.reduce((n, l) => n + (lineCents(l, l.discounts) ?? 0), 0) /
					100,
				unpriced: d.lines.filter((l) => l.unitCost === null).length,
			};
	// Freight and the like are part of what the PO costs.
	const total = shown.total + d.charges.reduce((n, c) => n + c.amount, 0);
	const wasSent = po.sentAt !== null;
	const amended = d.lines.filter(
		(l) => sinceSent(l, wasSent) === "amended",
	).length;
	const adjusted = d.lines.filter(
		(l) => sinceSent(l, wasSent) === "adjusted",
	).length;
	const changed = amended + adjusted;
	// Shown on the first card's header, so it reads once for the whole PO.
	const changes =
		changed > 0
			? [
					amended > 0 && `${formatCount(amended)} amended`,
					adjusted > 0 && `${formatCount(adjusted)} adjusted`,
				]
					.filter(Boolean)
					.join(", ")
			: null;
	const linesAside = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;
	const sentTotal =
		d.lines.reduce(
			(n, l) =>
				n +
				(lineCents(
					{ quantity: l.sentQuantity ?? 0, unitCost: l.sentUnitCost },
					l.sentDiscounts,
				) ?? 0),
			0,
		) / 100;
	const incoming = d.lines.filter((l) => l.received < l.quantity);
	// Lines with none coming sit last, under what did arrive.
	const arrived = d.lines
		.filter((l) => l.received >= l.quantity)
		.sort((a, b) => Number(a.quantity === 0) - Number(b.quantity === 0));
	const lineTable = (lines: Line[]) => (
		<LineTable
			detail={d}
			lines={lines}
			sort={lineSort}
			onSort={setLineSort}
			focus={focus}
			onEditQuantity={(lineId) => setFocus({ lineId, nonce: Date.now() })}
			onOpenDamage={setOpenDamageId}
			onReportDamage={(l, damage) =>
				setDamageTarget({
					kind: "new",
					damage,
					lineId: l.id,
					name: lineName(l),
					available: damageable(d, l),
					unit: l.packSize === 1 ? null : l.unit,
				})
			}
			onQuantityDone={(enter) => {
				setFocus(null);
				if (enter) picker.current?.focus();
			}}
		/>
	);
	const totals = (
		<>
			<ChargesRow detail={d} />
			<div className="flex items-center justify-end gap-6 border-t px-4 py-3">
				<span className="text-muted-foreground">
					{formatCount(shown.units)} {shown.units === 1 ? "unit" : "units"}
					{shown.unpriced > 0 && `, ${shown.unpriced} unpriced`}
				</span>
				{changed > 0 && sentTotal !== shown.total && (
					<span className="text-muted-foreground tabular-nums">
						Sent as {formatMoney(sentTotal)}
					</span>
				)}
				<span className="font-semibold tabular-nums">{formatMoney(total)}</span>
			</div>
		</>
	);

	const addItems = editable && (
		<AddItems
			detail={d}
			total={total}
			inputRef={picker}
			onFocusLine={(lineId) => setFocus({ lineId, nonce: Date.now() })}
		/>
	);

	// Says so when a change turns the suggestion into a draft.
	const wasSuggested = useRef(suggested);
	useEffect(() => {
		if (wasSuggested.current && po.status === "draft")
			toast.success(`Saved as draft PO ${po.id}`);
		wasSuggested.current = po.status === "suggested";
	}, [po.status, po.id]);

	useHotkeys({
		Escape: goBack,
		"/": (e) => {
			if (!editable) return;
			e.preventDefault();
			picker.current?.focus();
		},
	});

	// Ordered some other way: on order, no email. sentOn backdates it.
	const markSent = (sentOn?: string) =>
		run(
			() => sendPurchaseOrder({ data: { id: po.id, email: false, sentOn } }),
			() =>
				sentOn
					? `PO ${po.id} on order since ${formatDay(middayOf(sentOn))}`
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
							<Tip
								content={
									draft
										? undefined
										: "As sent to the supplier, without later changes"
								}
							>
								<a
									href={`/purchasing/pdf/${po.id}`}
									target="_blank"
									rel="noreferrer"
								>
									<FileText />
									PDF
								</a>
							</Tip>
						</Button>
					)}
					{unreported.length > 0 && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setReportingDamage(true)}
						>
							<ShieldAlert />
							Damage report ({unreported.length})
						</Button>
					)}
					{po.status === "sent" && d.lines.some(takenByReceiveAll) && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => receiveAllWithUndo(d.lines, po.id)}
						>
							<PackageCheck />
							Receive all
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
					{draft &&
						(d.supplier.email === null ? (
							<AddEmail
								supplier={d.supplier}
								patch={(email) =>
									poData.patch(po.id, (data) => ({
										...data,
										supplier: { ...data.supplier, email },
									}))
								}
							/>
						) : (
							<Tip
								content={
									d.emailConfigured
										? `Email the PDF to ${d.supplier.email}`
										: "Email isn't set up here (RESEND_API_KEY and PO_EMAIL_FROM). Download the PDF, order another way, and mark it sent."
								}
							>
								<Button
									size="sm"
									disabled={busy || d.lines.length === 0 || !d.emailConfigured}
									onClick={() => setComposing(true)}
								>
									<Mail />
									Send to supplier
								</Button>
							</Tip>
						))}
				</>
			}
		>
			{/* The lines need the width, so the side cards only sit beside them on
			    wide screens. */}
			<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
				<div className="flex min-w-0 flex-col gap-4">
					{draft ? (
						<>
							<Card flush>
								<ReorderBar detail={d} />
								{lineTable(d.lines)}
								{totals}
							</Card>
							{addItems}
						</>
					) : (
						<>
							<FlagsCard flags={d.flags} />
							{/* Like Shopify's unfulfilled and fulfilled cards: a line moves
							    down once all of it is in. */}
							{incoming.length > 0 && (
								<Card
									flush
									title={po.status === "sent" ? "Incoming" : "Not received"}
									tone={changes ? "warning" : undefined}
									aside={
										changes
											? `${changes} · ${linesAside(incoming.length)}`
											: linesAside(incoming.length)
									}
								>
									{lineTable(incoming)}
									{arrived.length === 0 && totals}
								</Card>
							)}
							{arrived.length > 0 && (
								<Card
									flush
									title="Received"
									tone={
										changes && incoming.length === 0 ? "warning" : undefined
									}
									aside={
										changes && incoming.length === 0
											? `${changes} · ${linesAside(arrived.length)}`
											: linesAside(arrived.length)
									}
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
							{addItems}
							<InvoicesCard detail={d} />
							<PaymentsCard detail={d} payables={d.payables} />
							<Timeline detail={d} />
						</>
					)}
				</div>

				<div className="flex flex-col gap-4">
					<SupplierPanel detail={d} />
					<TrackingCard detail={d} />
					<FilesCard detail={d} />
					{damageTarget && (
						<DamageDialog
							target={damageTarget}
							onClose={() => setDamageTarget(null)}
						/>
					)}
					{openDamage && (
						<DamageDetailsDialog
							damage={openDamage}
							onClose={() => setOpenDamageId(null)}
							onAddPhotos={() => {
								setOpenDamageId(null);
								setDamageTarget({
									kind: "photos",
									damageId: openDamage.id,
									name: damageName(openDamage),
								});
							}}
						/>
					)}
					{composing && (
						<SendDialog purchaseOrderId={po.id} onClose={stopComposing} />
					)}
					{reportingDamage && unreported.length > 0 && (
						<DamageReportDialog
							detail={d}
							damages={unreported}
							onClose={() => setReportingDamage(false)}
						/>
					)}

					<DeliveryCard detail={d} />

					<NotesCard detail={d} />

					<OtherActions
						detail={d}
						received={received}
						onSent={markSent}
						busy={busy}
						run={run}
					/>
				</div>
			</div>
		</Page>
	);
}
