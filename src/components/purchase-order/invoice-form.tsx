import { Check, TriangleAlert, X } from "lucide-react";
import {
	type ClipboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import { formatMoney } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import {
	type Discrepancy,
	explainDiscrepancy,
} from "#/purchasing/invoice-matching";
import {
	type PurchaseOrderDetail,
	saveSupplierSkus,
} from "#/server/purchasing";
import {
	checkSupplierInvoice,
	type InvoiceCheck,
	recordSupplierInvoice,
} from "#/server/purchasing/invoices";
import { today } from "./days";
import { poData } from "./po-data";

// One line as typed or pasted off the invoice.
type Row = { key: number; item: string; quantity: string; unitCost: string };

let nextKey = 0;
const blank = (): Row => ({
	key: nextKey++,
	item: "",
	quantity: "",
	unitCost: "",
});
const isBlank = (r: Row) => !r.item.trim() && !r.quantity && !r.unitCost;

// "$1,234.50" reads as 1234.5; anything else that isn't a number is null.
function money(s: string) {
	const t = s.replace(/[$,\s]/g, "");
	return /^\d*\.?\d+$/.test(t) ? Number(t) : null;
}
const count = (s: string) =>
	/^\d+$/.test(s.replace(/,/g, "").trim()) ? Number(s.replace(/,/g, "")) : null;

// Letters and digits only, as the server compares item numbers.
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Always one empty row at the end to type the next line into. Rows emptied
// above it stay, so clearing one while typing doesn't take it away.
const withSpare = (rows: Row[]) =>
	rows.length > 0 && isBlank(rows[rows.length - 1]) ? rows : [...rows, blank()];

// Rows copied from a spreadsheet or PDF: the item first, then its quantity,
// then the price after it. Other columns, like a description, are passed
// over. Each lands as a row to check and fix by hand.
function parsePasted(text: string): Row[] {
	return text
		.split(/\r?\n/)
		.map((l) => l.split("\t").map((c) => c.trim()))
		.filter((cols) => cols.some(Boolean))
		.map((cols) => {
			const q = cols.findIndex((c, i) => i > 0 && count(c) !== null);
			const p =
				q === -1 ? -1 : cols.findIndex((c, i) => i > q && money(c) !== null);
			return {
				key: nextKey++,
				item: cols[0],
				quantity: q === -1 ? "" : String(count(cols[q])),
				unitCost: p === -1 ? "" : String(money(cols[p])),
			};
		});
}

const input =
	"h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 outline-none focus:border-ring";
const bad = "border-critical-border ring-2 ring-critical-border/40";

export function InvoiceForm({
	detail: d,
	onClose,
	onRecorded,
}: {
	detail: PurchaseOrderDetail;
	onClose: () => void;
	onRecorded: (number: string) => void;
}) {
	const po = d.order;
	const [number, setNumber] = useState("");
	const [invoicedOn, setInvoicedOn] = useState(today);
	const [dueOn, setDueOn] = useState("");
	const [total, setTotal] = useState("");
	const [freight, setFreight] = useState("");
	const [tax, setTax] = useState("");
	const [credits, setCredits] = useState("");
	const [rows, setRows] = useState<Row[]>(() => [blank()]);
	const [recording, setRecording] = useState(false);
	const inFlight = useRef(false);
	const [savingSkus, setSavingSkus] = useState(false);
	const form = useRef<HTMLDivElement>(null);

	// Our SKUs on the PO; an item typed as one of them matches by SKU, any
	// other by the supplier's item number.
	const ourSkus = new Set(d.lines.map((l) => key(l.sku)));
	const complete = rows.flatMap((r, i) => {
		const item = r.item.trim();
		const quantity = count(r.quantity);
		const unitCost = money(r.unitCost);
		if (!item || quantity === null || unitCost === null) return [];
		return [
			{
				line: i + 1,
				...(ourSkus.has(key(item)) ? { sku: item } : { supplierSku: item }),
				quantity,
				unitCost,
			},
		];
	});
	const totalValue = total ? money(total) : undefined;
	const freightValue = freight ? money(freight) : undefined;
	const taxValue = tax ? money(tax) : undefined;
	const creditsValue = credits ? money(credits) : undefined;
	const request =
		complete.length === 0
			? null
			: JSON.stringify({
					purchaseOrderId: po.id,
					...(number.trim() ? { number: number.trim() } : {}),
					...(totalValue != null ? { total: totalValue } : {}),
					...(freightValue != null ? { freight: freightValue } : {}),
					...(taxValue != null ? { tax: taxValue } : {}),
					...(creditsValue ? { credits: creditsValue } : {}),
					lines: complete,
				});

	// Checked a moment after typing stops. A result is only shown against
	// what it was checked for; until the next one lands, the last one fades.
	const [check, setCheck] = useState<{
		request: string;
		value: InvoiceCheck;
	} | null>(null);
	const [nonce, setNonce] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: nonce checks again once item numbers are saved
	useEffect(() => {
		if (!request) return;
		let live = true;
		const t = setTimeout(() => {
			checkSupplierInvoice({ data: JSON.parse(request) }).then(
				(value) => live && setCheck({ request, value }),
				(error: unknown) =>
					live &&
					toast.error(error instanceof Error ? error.message : String(error)),
			);
		}, 400);
		return () => {
			live = false;
			clearTimeout(t);
		};
	}, [request, nonce]);
	const result = request && check ? check.value : null;
	const stale = check !== null && check.request !== request;

	const differences = new Map(result?.differences.map((x) => [x.line, x]));
	const cumulative = stale ? null : (result?.cumulative.match ?? null);
	const beyond = new Map(
		(cumulative?.kind === "exception" ? cumulative.discrepancies : []).flatMap(
			(x) => (x.kind === "beyond_received" ? [[x.position, x] as const] : []),
		),
	);
	const notOnPo = new Map(result?.notOnPo.map((x) => [x.line, x]));
	const checkedLines = new Set(
		check
			? JSON.parse(check.request).lines.map((l: { line: number }) => l.line)
			: [],
	);

	const alreadyRecorded =
		!stale && result?.alreadyRecorded ? result.alreadyRecorded : null;
	const dueValid = !dueOn || dueOn >= invoicedOn;
	const canRecord =
		number.trim() !== "" &&
		invoicedOn !== "" &&
		totalValue != null &&
		dueValid &&
		!alreadyRecorded &&
		!recording;

	function edit(i: number, change: Partial<Row>) {
		setRows((rs) =>
			withSpare(rs.map((r, j) => (j === i ? { ...r, ...change } : r))),
		);
	}

	function paste(i: number, e: ClipboardEvent<HTMLInputElement>) {
		const text = e.clipboardData.getData("text");
		if (!/[\t\n]/.test(text.trim())) return;
		e.preventDefault();
		const pasted = parsePasted(text);
		setRows((rs) =>
			withSpare([...rs.slice(0, i), ...pasted, ...rs.slice(i + 1)]),
		);
	}

	async function record() {
		if (inFlight.current || !canRecord || totalValue == null) return;
		inFlight.current = true;
		setRecording(true);
		const r = await optimism.change({
			label: `Recording invoice ${number.trim()}`,
			patch: [],
			send: () =>
				recordSupplierInvoice({
					data: {
						purchaseOrderId: po.id,
						number: number.trim(),
						invoicedOn,
						dueOn: dueOn || null,
						total: totalValue,
						...(freightValue != null ? { freight: freightValue } : {}),
						...(taxValue != null ? { tax: taxValue } : {}),
						...(creditsValue ? { credits: creditsValue } : {}),
						lines: complete,
					},
				}),
		});
		setRecording(false);
		inFlight.current = false;
		if (r) onRecorded(r.value.number);
		else shake(form.current);
	}

	async function saveSkus(items: { sku: string; supplierSku: string }[]) {
		setSavingSkus(true);
		const skus = new Set(items.map((i) => i.sku));
		const given = new Map(items.map((i) => [i.sku, i.supplierSku]));
		const r = await optimism.change({
			label: "Saving item numbers",
			patch: poData.patch(po.id, (data) => ({
				...data,
				lines: data.lines.map((l) =>
					skus.has(l.sku) && l.supplierSku === null
						? { ...l, supplierSku: given.get(l.sku) ?? null }
						: l,
				),
			})),
			send: () => saveSupplierSkus({ data: { purchaseOrderId: po.id, items } }),
		});
		setSavingSkus(false);
		if (!r) return;
		const { filled, kept, skipped } = r.value;
		const missed = [...kept.map((k) => k.sku), ...skipped.map((s) => s.sku)];
		if (missed.length > 0)
			toast.warning(`Not saved for ${missed.join(", ")}`, {
				description: [
					...kept.map((k) => `${k.sku} already has ${k.ours}`),
					...skipped.map((s) => `${s.sku}: ${s.reason}`),
				].join("; "),
			});
		else
			toast.success(
				`Saved ${filled.length} item ${filled.length === 1 ? "number" : "numbers"}`,
			);
		setNonce((n) => n + 1);
	}

	return (
		<div ref={form} className="flex flex-col gap-3 border-t px-4 py-3">
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-7">
				<Field label="Invoice number" className="col-span-2">
					<input
						// biome-ignore lint/a11y/noAutofocus: opened by clicking Add
						autoFocus
						value={number}
						onChange={(e) => setNumber(e.target.value)}
						onKeyDown={(e) => e.key === "Escape" && onClose()}
						className={cn(input, "font-mono", alreadyRecorded && bad)}
					/>
				</Field>
				<Field label="Dated">
					<input
						type="date"
						value={invoicedOn}
						onChange={(e) => setInvoicedOn(e.target.value || today())}
						className={cn(input, "tabular-nums")}
					/>
				</Field>
				<Field label="Due">
					<input
						type="date"
						value={dueOn}
						min={invoicedOn}
						onChange={(e) => setDueOn(e.target.value)}
						className={cn(input, "tabular-nums", !dueValid && bad)}
					/>
				</Field>
				<Field label="Freight">
					<MoneyInput value={freight} onChange={setFreight} />
				</Field>
				<Field label="Tax">
					<MoneyInput value={tax} onChange={setTax} />
				</Field>
				<Field label="Discounts">
					<MoneyInput value={credits} onChange={setCredits} />
				</Field>
			</div>

			<table className="w-full table-fixed">
				<thead className="text-left text-xs text-muted-foreground">
					<tr>
						<th className="w-6 font-normal">#</th>
						<th className="font-normal">Their item number or our SKU</th>
						<th className="w-20 font-normal">Qty</th>
						<th className="w-28 font-normal">Unit price</th>
						<th className="w-24 text-right font-normal">Amount</th>
						<th className="w-[40%] pl-3 font-normal" />
					</tr>
				</thead>
				<tbody className={cn("transition-opacity", stale && "opacity-60")}>
					{rows.map((r, i) => {
						const line = i + 1;
						const q = count(r.quantity);
						const p = money(r.unitCost);
						return (
							<tr key={r.key} className="align-top">
								<td className="pt-2 text-xs text-muted-foreground tabular-nums">
									{isBlank(r) ? "" : line}
								</td>
								<td className="py-0.5 pr-1">
									<input
										value={r.item}
										placeholder={i === 0 ? "Paste rows from the invoice" : ""}
										onChange={(e) => edit(i, { item: e.target.value })}
										onPaste={(e) => paste(i, e)}
										className={cn(input, "font-mono text-xs")}
									/>
								</td>
								<td className="py-0.5 pr-1">
									<input
										inputMode="numeric"
										value={r.quantity}
										onChange={(e) => edit(i, { quantity: e.target.value })}
										className={cn(
											input,
											"text-right tabular-nums",
											r.quantity && q === null && bad,
										)}
									/>
								</td>
								<td className="py-0.5 pr-1">
									<input
										inputMode="decimal"
										value={r.unitCost}
										onChange={(e) => edit(i, { unitCost: e.target.value })}
										className={cn(
											input,
											"text-right tabular-nums",
											r.unitCost && p === null && bad,
										)}
									/>
								</td>
								<td className="pt-1.5 text-right tabular-nums">
									{q !== null && p !== null && formatMoney(q * p)}
								</td>
								<td className="pt-1.5 pl-3">
									{result && checkedLines.has(line) && (
										<LineResult
											difference={differences.get(line)}
											missing={notOnPo.get(line)}
											beyond={beyond.get(line)}
										/>
									)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>

			{result && (
				<Summary
					result={result}
					received={cumulative?.kind === "matched"}
					stale={stale}
					savingSkus={savingSkus}
					onSaveSkus={saveSkus}
				/>
			)}

			<div className="flex items-end justify-end gap-2">
				{alreadyRecorded && (
					<span className="mr-auto self-center text-critical-text">
						{alreadyRecorded}
					</span>
				)}
				<Field label="Total due">
					<MoneyInput value={total} onChange={setTotal} />
				</Field>
				<Button size="sm" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button
					size="sm"
					disabled={!canRecord}
					onClick={record}
					className={cn(
						cumulative?.kind === "exception" &&
							"bg-warning-text text-background hover:bg-warning-text/90",
					)}
				>
					{cumulative?.kind === "exception"
						? "Record as exception"
						: "Record invoice"}
				</Button>
			</div>
		</div>
	);
}

function Field({
	label,
	className,
	children,
}: {
	label: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is its child
		<label className={cn("flex flex-col gap-0.5", className)}>
			<span className="text-xs text-muted-foreground">{label}</span>
			{children}
		</label>
	);
}

function MoneyInput({
	value,
	onChange,
}: {
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<input
			inputMode="decimal"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			className={cn(
				input,
				"w-28 text-right tabular-nums",
				value && money(value) === null && bad,
			)}
		/>
	);
}

// A line's verdict: a check when it agrees with the PO, what the PO says
// where it doesn't, or why it fits no PO line.
function LineResult({
	difference,
	missing,
	beyond,
}: {
	difference?: InvoiceCheck["differences"][number];
	missing?: InvoiceCheck["notOnPo"][number];
	beyond?: Discrepancy;
}) {
	if (missing)
		return (
			<span className="flex items-start gap-1 text-critical-text">
				<X className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0">{missing.reason}</span>
			</span>
		);
	if (difference) {
		const has = (issue: string) => difference.issues.includes(issue);
		return (
			<span className="flex items-start gap-1 text-warning-text">
				<TriangleAlert className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0">
					<span className="font-mono text-xs">{difference.sku}</span>, PO has{" "}
					<span className={cn(has("quantity") && "font-semibold")}>
						{difference.po.quantity} {difference.unit}
					</span>{" "}
					at{" "}
					<span
						className={cn(
							(has("price") || has("PO has no price")) && "font-semibold",
						)}
					>
						{formatMoney(difference.po.unitCost)}
					</span>
				</span>
			</span>
		);
	}
	if (beyond)
		return (
			<span className="flex items-start gap-1 text-warning-text">
				<TriangleAlert className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0">{explainDiscrepancy(beyond)}</span>
			</span>
		);
	return (
		<span className="flex items-center gap-1 text-success-text">
			<Check className="size-4" />
		</span>
	);
}

function Summary({
	result,
	received,
	stale,
	savingSkus,
	onSaveSkus,
}: {
	result: InvoiceCheck;
	received: boolean;
	stale: boolean;
	savingSkus: boolean;
	onSaveSkus: (items: { sku: string; supplierSku: string }[]) => void;
}) {
	const t = result.totals;
	const over = t.invoiceOverPo;
	// The invoice's own arithmetic, when it gives a total to check.
	const off = t.invoiceArithmeticOff;
	return (
		<div
			className={cn(
				"flex flex-col gap-2 rounded-lg px-3 py-2 transition-opacity",
				result.matches || received ? "bg-success-fill" : "bg-warning-fill",
				stale && "opacity-60",
			)}
		>
			<p className="flex flex-wrap items-center gap-x-4 gap-y-1">
				{result.matches || received ? (
					<span className="flex items-center gap-1 font-semibold text-success-text">
						<Check className="size-4" />
						{result.matches ? "Matches the PO" : "Matches what's received"}
					</span>
				) : (
					<span className="font-semibold text-warning-text">
						{t.matchingLines} of {t.poLines} PO lines match
					</span>
				)}
				<span className="tabular-nums">
					Lines {formatMoney(t.invoiceLinesTotal)} · PO {formatMoney(t.poTotal)}
					{over !== 0 && (
						<span className="font-semibold text-warning-text">
							{" "}
							· {formatMoney(Math.abs(over))} {over > 0 ? "over" : "under"}
						</span>
					)}
				</span>
				{off !== undefined && off !== 0 && (
					<span className="font-semibold text-critical-text tabular-nums">
						Total is {formatMoney(Math.abs(off))} {off > 0 ? "more" : "less"}{" "}
						than lines, freight, and tax
					</span>
				)}
			</p>
			{result.note && <p className="text-warning-text">{result.note}</p>}
			{result.notOnInvoice.length > 0 && (
				<p className="text-critical-text">
					Not on the invoice:{" "}
					{result.notOnInvoice.map((l, i) => (
						<span key={l.sku}>
							{i > 0 && ", "}
							<span className="font-mono text-xs">{l.sku}</span> ({l.quantity}{" "}
							{l.unit})
						</span>
					))}
				</p>
			)}
			{result.supplierSkuConflicts.map((c) => (
				<p key={c.sku} className="text-warning-text">
					<span className="font-mono text-xs">{c.sku}</span> is{" "}
					<span className="font-mono text-xs">{c.ours}</span> to us,{" "}
					<span className="font-mono text-xs">{c.invoice}</span> on the invoice
				</p>
			))}
			{result.supplierSkusToSave.length > 0 && (
				<div className="flex items-center gap-3">
					<Button
						size="sm"
						variant="outline"
						disabled={savingSkus || stale}
						onClick={() => onSaveSkus(result.supplierSkusToSave)}
					>
						Save {result.supplierSkusToSave.length} item{" "}
						{result.supplierSkusToSave.length === 1 ? "number" : "numbers"}
					</Button>
					<span className="text-xs text-muted-foreground">
						{result.supplierSkusToSave
							.map((s) => `${s.sku} = ${s.supplierSku}`)
							.join(", ")}
					</span>
				</div>
			)}
		</div>
	);
}
