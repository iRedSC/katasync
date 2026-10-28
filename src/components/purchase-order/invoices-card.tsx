import { Check, Plus, RotateCcw, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatDay, formatMoney } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { explainDiscrepancy } from "#/purchasing/invoice-matching";
import type { PurchaseOrderDetail } from "#/server/purchasing";
import {
	restoreSupplierInvoice,
	voidSupplierInvoice,
} from "#/server/purchasing/invoices";
import { InvoiceForm } from "./invoice-form";
import { poData } from "./po-data";

type Invoice = PurchaseOrderDetail["invoices"][number];

const markVoid = (poId: number, id: number, voided: Invoice["voided"]) =>
	poData.patch(poId, (data) => ({
		...data,
		invoices: data.invoices.map((x) =>
			x.id === id
				? {
						...x,
						voided,
						match: voided ? { kind: "void" as const } : x.match,
						payment: voided ? { kind: "void" as const } : x.payment,
					}
				: x,
		),
	}));

// A sent PO's supplier invoices: recorded ones, and checking a new one line
// by line against the PO before recording it.
export function InvoicesCard({ detail: d }: { detail: PurchaseOrderDetail }) {
	const po = d.order;
	const [checking, setChecking] = useState(false);
	// The invoice just recorded, lit up for a moment so it's seen landing.
	const [fresh, setFresh] = useState<string | null>(null);
	useEffect(() => {
		if (!fresh) return;
		const t = setTimeout(() => setFresh(null), 2500);
		return () => clearTimeout(t);
	}, [fresh]);

	if (po.status !== "sent" && po.status !== "closed") return null;

	async function restore(inv: Invoice) {
		const r = await optimism.change({
			label: `Restoring invoice ${inv.number}`,
			patch: markVoid(po.id, inv.id, null),
			send: () => restoreSupplierInvoice({ data: { id: inv.id } }),
		});
		if (r) setFresh(inv.number);
		return r;
	}

	async function remove(inv: Invoice) {
		const r = await optimism.change({
			label: `Voiding invoice ${inv.number}`,
			patch: markVoid(po.id, inv.id, { at: new Date(), reason: null }),
			send: () => voidSupplierInvoice({ data: { id: inv.id } }),
		});
		if (!r) return;
		const released = r.value.releasedCents;
		offerUndo(`Voided invoice ${inv.number}`, {
			description:
				released > 0
					? `${formatMoney(released / 100)} of payments is unapplied credit now`
					: undefined,
			undo: async () =>
				(await restore(inv)) ? `Invoice ${inv.number} is back` : null,
		});
	}

	return (
		<Card
			flush
			title="Invoices"
			aside={
				!checking && (
					<Button
						size="sm"
						variant="ghost"
						className="-my-1 text-muted-foreground"
						onClick={() => setChecking(true)}
					>
						<Plus />
						Add
					</Button>
				)
			}
		>
			{d.invoices.length > 0 && (
				<ul className="pb-2">
					{d.invoices.map((inv) => (
						<InvoiceRow
							key={inv.id}
							invoice={inv}
							fresh={fresh === inv.number}
							onVoid={() => remove(inv)}
							onRestore={() => restore(inv)}
						/>
					))}
				</ul>
			)}
			<UnverifiedNote detail={d} />
			{checking && (
				<InvoiceForm
					detail={d}
					onClose={() => setChecking(false)}
					onRecorded={(number) => {
						setChecking(false);
						setFresh(number);
					}}
				/>
			)}
		</Card>
	);
}

function InvoiceRow({
	invoice: inv,
	fresh,
	onVoid,
	onRestore,
}: {
	invoice: Invoice;
	fresh: boolean;
	onVoid: () => void;
	onRestore: () => void;
}) {
	const voided = inv.voided !== null;
	return (
		<li
			className={cn(
				"group flex flex-col px-4 py-1.5 transition-colors duration-700",
				fresh && "bg-success-fill",
			)}
		>
			<div className="flex items-center gap-3">
				<span
					className={cn(
						"font-semibold",
						voided && "text-muted-foreground line-through",
					)}
				>
					{inv.number}
				</span>
				<span className="text-muted-foreground">
					{formatDay(inv.invoicedOn)}
					{inv.dueOn && <>, due {formatDay(inv.dueOn)}</>}
				</span>
				<MatchChip match={inv.match} />
				<span
					className={cn(
						"ml-auto tabular-nums",
						voided && "text-muted-foreground line-through",
					)}
				>
					{formatMoney(inv.total)}
				</span>
				<PaymentChip payment={inv.payment} />
				{voided ? (
					<Button
						size="xs"
						variant="ghost"
						className="text-muted-foreground"
						onClick={onRestore}
					>
						<RotateCcw />
						Restore
					</Button>
				) : (
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label={`Void invoice ${inv.number}`}
						className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
						onClick={onVoid}
					>
						<X />
					</Button>
				)}
			</div>
			{inv.match.kind === "exception" && (
				<ul className="pl-1 text-xs text-warning-text">
					{inv.match.discrepancies.map((x) => (
						<li key={`${x.kind}-${"position" in x ? x.position : 0}`}>
							{explainDiscrepancy(x)}
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

function MatchChip({ match }: { match: Invoice["match"] }) {
	const chip = "flex items-center gap-1 rounded-full px-2 text-xs";
	switch (match.kind) {
		case "matched":
			return (
				<span className={cn(chip, "bg-success-fill text-success-text")}>
					<Check className="size-3" />
					Matched
				</span>
			);
		case "exception":
			return (
				<span className={cn(chip, "bg-warning-fill text-warning-text")}>
					<TriangleAlert className="size-3" />
					Exception
				</span>
			);
		case "header_only":
			return (
				<span className={cn(chip, "bg-muted text-muted-foreground")}>
					No lines
				</span>
			);
		case "legacy":
			return (
				<span className={cn(chip, "bg-muted text-muted-foreground")}>
					Unverified
				</span>
			);
		case "void":
			return (
				<span className={cn(chip, "bg-muted text-muted-foreground")}>Void</span>
			);
		default: {
			const unreachable: never = match;
			return unreachable;
		}
	}
}

function PaymentChip({ payment }: { payment: Invoice["payment"] }) {
	switch (payment.kind) {
		case "void":
			return null;
		case "paid":
			return <span className="text-xs text-success-text">Paid</span>;
		case "partial":
			return (
				<span className="text-xs text-warning-text tabular-nums">
					{formatMoney(payment.openCents / 100)} open
				</span>
			);
		case "unpaid":
			return <span className="text-xs text-muted-foreground">Unpaid</span>;
		case "unknown":
			return (
				<span className="text-xs text-muted-foreground">Paid? Unknown</span>
			);
		default: {
			const unreachable: never = payment;
			return unreachable;
		}
	}
}

function UnverifiedNote({ detail: d }: { detail: PurchaseOrderDetail }) {
	const unverified = d.invoices.filter(
		(i) => i.match.kind === "legacy" || i.match.kind === "header_only",
	).length;
	if (unverified === 0) return null;
	return (
		<p className="px-4 pb-2 text-xs text-muted-foreground">
			{unverified === 1 ? "1 invoice has" : `${unverified} invoices have`} no
			lines, so billing can't be checked against receipts
		</p>
	);
}
