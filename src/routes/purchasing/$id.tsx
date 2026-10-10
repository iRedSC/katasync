import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { Download, Mail, Smartphone } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Badge, Banner, Card, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
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
	getPurchaseOrderPdf,
	type PurchaseOrderDetail,
	receiveLine,
	sendPurchaseOrder,
	setLine,
	undoPurchaseReceipt,
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
	const ordered = d.lines.reduce((n, l) => n + l.quantity, 0);
	const received = d.lines.reduce(
		(n, l) => n + Math.min(l.received, l.quantity),
		0,
	);
	const status = purchaseOrderStatus({ ...po, ordered, received });
	const total = d.lines.reduce((n, l) => n + l.quantity * (l.unitCost ?? 0), 0);
	const unpriced = d.lines.filter((l) => l.unitCost === null).length;
	const canEmail = d.emailConfigured && Boolean(d.supplier.email);

	useHotkeys({ Escape: () => navigate({ to: "/purchasing" }) });

	async function downloadPdf() {
		await run(async () => {
			const { base64, filename } = await getPurchaseOrderPdf({
				data: { id: po.id },
			});
			const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
			const url = URL.createObjectURL(
				new Blob([bytes], { type: "application/pdf" }),
			);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);
		});
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
			narrow
			back={{ to: "/purchasing" }}
			title={
				<span className="flex items-center gap-2">
					PO {po.id}
					<Badge tone={status.tone}>{status.label}</Badge>
				</span>
			}
			actions={
				<>
					<Button
						variant="outline"
						size="sm"
						disabled={busy || d.lines.length === 0}
						onClick={downloadPdf}
					>
						<Download />
						PDF
					</Button>
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

			<div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<div className="flex min-w-0 flex-col gap-4">
					<Card flush>
						<LineTable detail={d} />
						<div className="flex items-center justify-end gap-6 border-t px-4 py-3">
							{draft && <AddLine purchaseOrderId={po.id} />}
							<span className="text-muted-foreground">
								{formatCount(ordered)} {ordered === 1 ? "unit" : "units"}
								{unpriced > 0 && `, ${unpriced} without a price`}
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
					{draft && (
						<th className="px-2 py-2 text-right font-medium">On hand</th>
					)}
					<th className="px-2 py-2 text-right font-medium">Qty</th>
					<th className="px-2 py-2 text-right font-medium">Price</th>
					<th className="px-4 py-2 text-right font-medium">Amount</th>
					{!draft && (
						<th className="px-4 py-2 text-right font-medium">Received</th>
					)}
				</tr>
			</thead>
			<tbody>
				{d.lines.map((l) => (
					<tr key={l.id} className="border-t first:border-t-0">
						<td className="w-full max-w-0 px-4 py-2">
							<div className="flex items-center gap-3">
								<ProductImage src={l.imageUrl} />
								<div className="min-w-0">
									<Link
										to="/products/$sku"
										params={{ sku: l.sku }}
										className="block hover:underline"
									>
										<ProductName name={l.name} variantName={l.variantName} />
									</Link>
									<div className="truncate text-xs text-muted-foreground">
										{l.sku}
										{l.supplierSku && ` · theirs ${l.supplierSku}`}
									</div>
								</div>
							</div>
						</td>
						{draft && (
							<td
								className={cn(
									"px-2 py-2 text-right tabular-nums",
									l.onHand < 0 ? "text-critical-text" : "text-muted-foreground",
								)}
							>
								{formatCount(l.onHand)}
							</td>
						)}
						<td className="px-2 py-2 text-right tabular-nums">
							{draft ? (
								<DraftField
									key={`q${l.quantity}`}
									line={l}
									purchaseOrderId={d.order.id}
									field="quantity"
								/>
							) : (
								formatCount(l.quantity)
							)}
						</td>
						<td className="px-2 py-2 text-right tabular-nums">
							{draft ? (
								<DraftField
									key={`c${l.unitCost}`}
									line={l}
									purchaseOrderId={d.order.id}
									field="unitCost"
								/>
							) : (
								formatMoney(l.unitCost)
							)}
						</td>
						<td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">
							{l.unitCost === null ? "—" : formatMoney(l.unitCost * l.quantity)}
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
				))}
			</tbody>
		</table>
	);
}

const field =
	"h-8 rounded-lg border border-input bg-white px-2 text-right tabular-nums outline-none focus:border-ring";

// Quantity or price on a draft line. Saves on Enter or leaving the field; a
// quantity of 0 takes the line off. Escape puts the old value back.
function DraftField({
	line,
	purchaseOrderId,
	field: name,
}: {
	line: Line;
	purchaseOrderId: number;
	field: "quantity" | "unitCost";
}) {
	const { busy, run } = useAction();
	const initial =
		name === "quantity"
			? String(line.quantity)
			: (line.unitCost?.toFixed(2) ?? "");
	const [value, setValue] = useState(initial);

	function save() {
		if (value.trim() === initial) return;
		const n = Number(value);
		if (value.trim() !== "" && !(Number.isFinite(n) && n >= 0)) {
			toast.error(`"${value}" isn't a number`);
			setValue(initial);
			return;
		}
		run(() =>
			setLine({
				data:
					name === "quantity"
						? {
								purchaseOrderId,
								productId: line.productId,
								quantity: Math.round(n),
							}
						: {
								purchaseOrderId,
								productId: line.productId,
								quantity: line.quantity,
								unitCost: value.trim() === "" ? null : n,
							},
			}),
		);
	}

	return (
		<input
			value={value}
			disabled={busy}
			inputMode={name === "quantity" ? "numeric" : "decimal"}
			placeholder={name === "unitCost" ? "Price?" : undefined}
			aria-label={
				name === "quantity" ? `Quantity of ${line.sku}` : `Price of ${line.sku}`
			}
			onChange={(e) => setValue(e.target.value)}
			onBlur={save}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					setValue(initial);
					e.stopPropagation();
				}
			}}
			className={cn(field, name === "quantity" ? "w-16" : "w-20")}
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
			() => `Received ${formatCount(n)} × ${line.sku}`,
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
				aria-label={`Units of ${line.sku} received`}
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
								</span>{" "}
								× {line?.name ?? "?"}
							</span>
							<Button
								size="sm"
								variant="ghost"
								disabled={busy}
								onClick={() =>
									run(
										() => undoPurchaseReceipt({ data: { id: r.id } }),
										() => `Took ${formatCount(r.quantity)} back off the shelf`,
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
						Mark as sent (ordered by phone or online)
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
