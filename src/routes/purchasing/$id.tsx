import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { AlertTriangle, FileText, Mail, Smartphone } from "lucide-react";
import { Fragment, type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { useNumberLine } from "#/components/number-line";
import { Badge, Banner, Card, Page } from "#/components/page";
import { ProductImage } from "#/components/product";
import { PurchaseUnitCell } from "#/components/purchase-unit";
import { StockRing } from "#/components/stock-ring";
import { Button } from "#/components/ui/button";
import {
	cityLine,
	formatCount,
	formatDateTime,
	formatDay,
	formatMoney,
	formatPhone,
} from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";
import { purchaseOrderStatus } from "#/purchasing/status";
import { listProductIndex } from "#/server/catalog";
import {
	addLineBySku,
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

	useHotkeys({ Escape: () => navigate({ to: "/purchasing" }) });

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

			<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
				<div className="flex min-w-0 flex-col gap-4">
					<Card flush>
						{draft && <FrozenBar detail={d} />}
						<LineTable detail={d} />
						<div className="flex items-center justify-end gap-6 border-t px-4 py-3">
							{draft && <AddLine purchaseOrderId={po.id} />}
							<span className="text-muted-foreground">
								{formatCount(ordered)} {ordered === 1 ? "unit" : "units"}
								{unpriced > 0 && `, ${unpriced} without a price`}
								{sets > 0 &&
									`, plus ${sets === 1 ? "a set" : `${sets} sets`} priced as parts when sent`}
							</span>
							<span className="font-semibold tabular-nums">
								{formatMoney(total)}
							</span>
						</div>
					</Card>
					{d.receipts.length > 0 && <Receipts detail={d} />}
				</div>

				<div className="flex flex-col gap-4">
					<Card title="Supplier">
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
								<p className="mt-2 rounded-lg bg-[#f7f7f7] px-2 py-1.5">
									{d.supplier.notes}
								</p>
							)}
						</div>
					</Card>

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

function LineTable({ detail: d }: { detail: PurchaseOrderDetail }) {
	const draft = d.order.status === "draft";
	const receiving = d.order.status === "sent";
	if (d.lines.length === 0)
		return (
			<p className="px-4 py-6 text-center text-muted-foreground">
				Nothing on this PO yet. Add a product by SKU below.
			</p>
		);
	return (
		<table className="w-full">
			<thead>
				<tr className="border-b bg-[#f7f7f7] text-left text-xs text-muted-foreground">
					<th className="px-4 py-2 font-medium">Product</th>
					<th className="px-3 py-2 font-medium whitespace-nowrap">Their SKU</th>
					<th className="px-3 py-2 font-medium whitespace-nowrap">MOQ / UOM</th>
					{draft && (
						<th className="px-3 py-2 text-center font-medium whitespace-nowrap">
							On hand
						</th>
					)}
					<th className="px-3 py-2 text-right font-medium">Qty</th>
					<th className="px-3 py-2 text-right font-medium">Price</th>
					<th className="px-4 py-2 text-right font-medium">Amount</th>
					{!draft && (
						<th className="px-4 py-2 text-right font-medium">Received</th>
					)}
				</tr>
			</thead>
			<tbody>
				{d.lines.map((l) => (
					<Fragment key={l.id}>
						<tr className="border-t first:border-t-0">
							<td className="w-full max-w-0 px-4 py-2">
								<div className="flex items-center gap-3">
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
													<span className="ml-1.5 rounded-md bg-[#f1f1f1] px-1.5 text-xs font-normal text-muted-foreground">
														{l.variantName}
													</span>
												)}
											</span>
										</Link>
										<div className="text-xs text-muted-foreground">
											{l.sku}
											{l.kind === "bundle" && " · Set, sent as its parts"}
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
							{draft && (
								<td className="px-3 py-2 text-center">
									{l.kind === "bundle" || !l.stockRange ? (
										<span className="text-muted-foreground">—</span>
									) : (
										<StockRing onHand={l.onHand} range={l.stockRange} />
									)}
								</td>
							)}
							<td className="px-3 py-2 text-right font-semibold tabular-nums">
								{draft ? (
									<QuantityField
										key={`q${l.quantity}`}
										line={l}
										purchaseOrderId={d.order.id}
									/>
								) : (
									formatCount(l.quantity)
								)}
							</td>
							<td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
								{l.kind === "bundle" ? (
									<span className="text-muted-foreground">As parts</span>
								) : draft ? (
									<PriceField line={l} purchaseOrderId={d.order.id} />
								) : (
									formatMoney(l.unitCost)
								)}
							</td>
							<td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">
								{l.unitCost === null
									? "—"
									: formatMoney(l.unitCost * l.quantity)}
							</td>
							{!draft && (
								<td className="px-4 py-2 text-right whitespace-nowrap">
									{receiving && l.received < l.quantity ? (
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
	"h-9 w-16 rounded-lg border border-transparent bg-[#f1f1f1] px-2 text-right text-[0.9375rem] font-semibold tabular-nums outline-none";

// A draft line's quantity. Click to type a number, or drag sideways for the
// number line. 0 takes the line off, with Undo.
function QuantityField({
	line,
	purchaseOrderId,
}: {
	line: Line;
	purchaseOrderId: number;
}) {
	const { run } = useAction();
	const router = useRouter();
	const [typing, setTyping] = useState(false);
	const [text, setText] = useState("");

	async function save(quantity: number) {
		if (quantity === line.quantity) return;
		const r = await run(() =>
			setLine({
				data: { purchaseOrderId, productId: line.productId, quantity },
			}),
		);
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

	function finishTyping() {
		setTyping(false);
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
					if (e.key === "Enter") e.currentTarget.blur();
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
					"cursor-pointer select-none hover:bg-[#e8e8e8]",
					scrub.dragging && "cursor-ew-resize",
				)}
			>
				{scrub.dragging ? scrub.shown : line.quantity}
			</button>
			{scrub.line}
		</>
	);
}

// Reads as plain text with a dotted underline until clicked, and keeps its
// size while typing, so editing doesn't push the columns around. Saves on
// Enter or leaving the field; Escape puts the old text back. Shows what was
// typed until the saved value comes back.
function InlineField({
	shown,
	initial,
	placeholder,
	label,
	inputMode,
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
	className?: string;
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

	return (
		<input
			value={editing ? value : (pending ?? (initial === "" ? "" : shown))}
			placeholder={placeholder}
			aria-label={label}
			inputMode={inputMode}
			onFocus={(e) => {
				setValue(pending ?? initial);
				setEditing(true);
				const input = e.currentTarget;
				requestAnimationFrame(() => input.select());
			}}
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
				"h-8 cursor-text rounded-md border border-transparent bg-transparent px-1.5 tabular-nums outline-none placeholder:text-muted-foreground",
				"underline decoration-[#b5b5b5] decoration-dotted underline-offset-4 hover:decoration-foreground",
				"focus:border-ring focus:bg-white focus:no-underline",
				className,
			)}
		/>
	);
}

// A draft line's price. Empty means no price yet.
function PriceField({
	line,
	purchaseOrderId,
}: {
	line: Line;
	purchaseOrderId: number;
}) {
	const { run } = useAction();
	return (
		<InlineField
			shown={formatMoney(line.unitCost)}
			initial={line.unitCost?.toFixed(2) ?? ""}
			placeholder="Add price"
			label={`Price of ${line.sku}`}
			inputMode="decimal"
			className="w-24 text-right"
			onSave={async (text) => {
				const n = Number(text.replace(/^\$/, ""));
				if (text !== "" && !(Number.isFinite(n) && n >= 0)) {
					toast.error(`"${text}" isn't a price`);
					return false;
				}
				const r = await run(() =>
					setLine({
						data: {
							purchaseOrderId,
							productId: line.productId,
							quantity: line.quantity,
							unitCost: text === "" ? null : n,
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

// Adds a product by SKU, with the catalog as suggestions.
function AddLine({ purchaseOrderId }: { purchaseOrderId: number }) {
	const { busy, run } = useAction();
	const [sku, setSku] = useState("");
	const [index, setIndex] = useState<Awaited<
		ReturnType<typeof listProductIndex>
	> | null>(null);

	return (
		<form
			className="mr-auto flex items-center gap-1.5"
			onSubmit={async (e) => {
				e.preventDefault();
				const value = sku.trim();
				if (!value) return;
				const r = await run(
					() => addLineBySku({ data: { purchaseOrderId, sku: value } }),
					() => `Added ${value}`,
				);
				if (r) setSku("");
			}}
		>
			<input
				value={sku}
				list="po-skus"
				placeholder="Add a SKU"
				onFocus={() => index ?? listProductIndex().then(setIndex)}
				onChange={(e) => setSku(e.target.value)}
				className="h-8 w-44 rounded-lg border border-input bg-white px-2 outline-none focus:border-ring"
			/>
			<datalist id="po-skus">
				{index?.map((p) => (
					<option key={p.sku} value={p.sku}>
						{p.variantName ? `${p.name} (${p.variantName})` : p.name}
					</option>
				))}
			</datalist>
			<Button type="submit" size="sm" variant="outline" disabled={busy || !sku}>
				Add
			</Button>
		</form>
	);
}

function Receipts({ detail: d }: { detail: PurchaseOrderDetail }) {
	const { busy, run } = useAction();
	const lines = new Map(d.lines.map((l) => [l.id, l]));
	return (
		<Card title="Received" flush>
			<ul>
				{d.receipts.map((r) => {
					const line = lines.get(r.lineId);
					return (
						<li
							key={r.id}
							className="flex items-center gap-3 border-t px-4 py-2 first:border-t-0"
						>
							<span className="w-36 shrink-0 text-muted-foreground">
								{formatDateTime(r.createdAt)}
							</span>
							<span className="min-w-0 flex-1 truncate">
								<span className="font-semibold tabular-nums">
									{formatCount(r.quantity)}
								</span>
								{line && line.packSize !== 1 && ` ${line.unit}`} ×{" "}
								{line?.name ?? "?"}
							</span>
							<Button
								size="sm"
								variant="ghost"
								disabled={busy}
								onClick={() =>
									run(
										() => undoPurchaseReceipt({ data: { id: r.id } }),
										() =>
											`Took ${formatCount(r.quantity * (line?.packSize ?? 1))} back off the shelf`,
									)
								}
							>
								Undo
							</Button>
						</li>
					);
				})}
			</ul>
		</Card>
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
