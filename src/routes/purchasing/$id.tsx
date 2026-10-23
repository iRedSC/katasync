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
import { BrowseProducts, type BrowseRow } from "#/components/po-browse";
import {
	ProductPicker,
	type PurchaseOrderMatch,
} from "#/components/po-product-picker";
import { AddEmail } from "#/components/purchase-order/add-email";
import { middayOf } from "#/components/purchase-order/days";
import { DeliveryCard } from "#/components/purchase-order/delivery-card";
import { FilesCard } from "#/components/purchase-order/files-card";
import { InvoicesCard } from "#/components/purchase-order/invoices-card";
import { receiveAllWithUndo } from "#/components/purchase-order/line-actions";
import { damageable, lineName } from "#/components/purchase-order/line-damage";
import { LineTable } from "#/components/purchase-order/line-table";
import { browseLine } from "#/components/purchase-order/new-lines";
import { NotesCard } from "#/components/purchase-order/notes-card";
import { OtherActions } from "#/components/purchase-order/other-actions";
import {
	draftTotals,
	isUnsent,
	poData,
	sinceSent,
} from "#/components/purchase-order/po-data";
import { Recommended } from "#/components/purchase-order/recommended";
import {
	FrozenBar,
	SuggestedBar,
} from "#/components/purchase-order/reorder-bar";
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
import { ids } from "#/lib/optimism";
import { lineCents } from "#/purchasing/discount";
import { purchaseOrderStatus, takenByReceiveAll } from "#/purchasing/status";
import {
	addProductToPurchaseOrder,
	getPurchaseOrder,
	sendPurchaseOrder,
} from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/$id")({
	loader: ({ params }) => getPurchaseOrder({ data: { id: Number(params.id) } }),
	component: PurchaseOrderPage,
	pendingComponent: PurchaseOrderSkeleton,
});

function PurchaseOrderPage() {
	const loaded = Route.useLoaderData();
	const d = poData.useData(loaded.order.id, loaded);
	const goBack = useBack({ to: "/purchasing" });
	const { busy, run, save } = useAction();
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
	const [browsing, setBrowsing] = useState(false);
	// The line just added or picked, so it scrolls into view with its
	// quantity open. The nonce reopens it when picked again.
	const [focus, setFocus] = useState<LineFocus | null>(null);
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
	const total = shown.total;
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
			{editable && (
				<ProductPicker
					ref={picker}
					purchaseOrderId={po.id}
					sent={!draft}
					busy={busy}
					onPick={pick}
					onBrowse={() => setBrowsing(true)}
				/>
			)}
			<div className="flex items-center justify-end gap-6 border-t px-4 py-3">
				<span className="text-muted-foreground">
					{formatCount(shown.units)} {shown.units === 1 ? "unit" : "units"}
					{shown.unpriced > 0 && `, ${shown.unpriced} unpriced`}
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
						: `Added ${m.sku}`,
		);
		if (!r) return false;
		setFocus({ lineId: r.value.lineId, nonce: Date.now() });
		return true;
	}

	// From Browse, which stays open to add more, so no line opens behind it.
	// The line shows at once, as the server will make it, under an id of its
	// own until the server's comes back; Browse's row flips with it.
	function addFromBrowse(row: BrowseRow) {
		const id = ids.provisional();
		const line = browseLine(row, id, d.supplier.id);
		return save({
			label: `Adding ${row.sku}`,
			patch: poData.patch(po.id, (data) => ({
				...data,
				// A suggested PO's first change saves it as a draft.
				order:
					data.order.status === "suggested"
						? { ...data.order, status: "draft" }
						: data.order,
				lines: data.lines.some((l) => l.productId === row.id)
					? data.lines
					: [...data.lines, line],
				recommended: data.recommended.filter((x) => x.productId !== row.id),
			})),
			send: async () => {
				const res = await addProductToPurchaseOrder({
					data: { purchaseOrderId: po.id, productId: row.id },
				});
				ids.confirm(id, res.lineId);
				return res;
			},
			success: (r) =>
				!r.added
					? `${row.sku} is already on this PO`
					: draft
						? `Added ${row.sku}`
						: `Added ${row.sku}`,
		});
	}

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
								{suggested ? <SuggestedBar /> : <FrozenBar detail={d} />}
								{lineTable(d.lines)}
								{totals}
							</Card>
							<Recommended detail={d} total={total} />
						</>
					) : (
						<>
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
							<InvoicesCard detail={d} />
							<Timeline detail={d} />
						</>
					)}
				</div>

				<div className="flex flex-col gap-4">
					<SupplierPanel detail={d} />
					<TrackingCard detail={d} />
					<FilesCard detail={d} />
					<BrowseProducts
						purchaseOrderId={po.id}
						supplierName={d.supplier.name}
						sent={!draft}
						open={browsing && editable}
						onOpenChange={setBrowsing}
						onPo={new Map(d.lines.map((l) => [l.productId, l.id]))}
						busy={busy}
						onAdd={addFromBrowse}
						onGoToLine={(lineId) => setFocus({ lineId, nonce: Date.now() })}
					/>
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
