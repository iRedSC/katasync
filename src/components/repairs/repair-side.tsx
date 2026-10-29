import { ExternalLink, LoaderCircle, Mail, Pencil } from "lucide-react";
import { useRef, useState } from "react";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatMoney, formatPhone } from "#/lib/format";
import { CustomerPicker, type FoundCustomer } from "./customer-picker";
import { useDraft } from "./draft";
import type { Detail } from "./repair-data";
import { TechPicker } from "./tech-picker";

// The side of a repair's page: whose it is, who has it, and what it comes
// to on the draft order.

export function CustomerCard({
	d,
	editable,
	onChange,
}: {
	d: Detail;
	editable: boolean;
	onChange: (c: FoundCustomer) => void;
}) {
	const [changing, setChanging] = useState(false);
	const r = d.repair;
	return (
		<Card
			title="Customer"
			aside={
				editable &&
				!changing && (
					<button
						type="button"
						className="text-link"
						onClick={() => setChanging(true)}
					>
						Change
					</button>
				)
			}
		>
			{changing ? (
				<CustomerPicker
					onPick={(c) => {
						setChanging(false);
						onChange(c);
					}}
					onNew={() => setChanging(false)}
				/>
			) : (
				<div className="flex flex-col gap-1">
					<span className="text-lg font-semibold">{r.customerName}</span>
					{r.customerPhone && (
						<a
							href={`tel:${r.customerPhone}`}
							className="text-link tabular-nums"
						>
							{formatPhone(r.customerPhone)}
						</a>
					)}
					{r.customerEmail && (
						<span className="text-muted-foreground">{r.customerEmail}</span>
					)}
				</div>
			)}
		</Card>
	);
}

export function PeopleCard({
	d,
	onTechnician,
	onNotes,
}: {
	d: Detail;
	onTechnician: (id: number | null) => void;
	onNotes: (notes: string) => void;
}) {
	const notes = useDraft(d.repair.notes, `notes-${d.repair.id}`);
	return (
		<Card title="Technician">
			<TechPicker
				people={d.people}
				value={d.repair.technicianId}
				onChange={onTechnician}
			/>
			<textarea
				value={notes.value}
				onChange={(e) => notes.type(e.target.value)}
				onBlur={() => {
					const text = notes.save();
					if (text !== null) onNotes(text);
				}}
				placeholder="Shop notes (not on the order)"
				rows={2}
				className="mt-3 w-full resize-none rounded-lg bg-surface px-3 py-2 outline-none"
			/>
		</Card>
	);
}

export function BillCard({
	d,
	onEmail,
}: {
	d: Detail;
	// Resolves once the invoice has gone, or failed and said why.
	onEmail: () => Promise<void>;
}) {
	const draft = d.draft;
	const r = d.repair;
	if (r.orderName)
		return (
			<Card title="Paid">
				<span className="font-semibold text-success-text">
					Order {r.orderName}
				</span>
			</Card>
		);
	if (draft.kind === "none")
		return (
			<Card title="Draft order">
				<span className="text-muted-foreground">
					Made with the first labor or part
				</span>
			</Card>
		);
	if (draft.kind === "unreadable")
		return (
			<Card title="Draft order" tone="warning" aside="Couldn't read">
				<span className="text-sm">{draft.error}</span>
			</Card>
		);
	const row = (label: string, value: number, strong = false) => (
		<div
			className={
				strong
					? "flex justify-between font-semibold"
					: "flex justify-between text-muted-foreground"
			}
		>
			<span>{label}</span>
			<span className="tabular-nums">{formatMoney(value)}</span>
		</div>
	);
	return (
		<Card
			title={`Draft order ${draft.name}`}
			aside={
				d.draftUrl && (
					<a
						href={d.draftUrl}
						target="_blank"
						rel="noreferrer"
						className="flex items-center gap-1 text-link"
					>
						Shopify <ExternalLink className="size-3.5" />
					</a>
				)
			}
		>
			<div className="flex flex-col gap-1">
				{row("Subtotal", draft.subtotal)}
				{row("Tax", draft.tax)}
				{row("Total", draft.total, true)}
			</div>
			<InvoiceButton
				email={r.customerEmail}
				sentBefore={Boolean(draft.invoiceSentAt)}
				onEmail={onEmail}
			/>
		</Card>
	);
}

// Emails the customer the invoice. One goes out per click: while it sends
// the button is busy and further clicks do nothing, and once it has gone, a
// click is a deliberate resend.
function InvoiceButton({
	email,
	sentBefore,
	onEmail,
}: {
	email: string | null;
	sentBefore: boolean;
	onEmail: () => Promise<void>;
}) {
	const [sending, setSending] = useState(false);
	// Set at once, where state would only show on the next render.
	const busy = useRef(false);
	async function send() {
		if (busy.current) return;
		busy.current = true;
		setSending(true);
		try {
			await onEmail();
		} finally {
			busy.current = false;
			setSending(false);
		}
	}
	return (
		<Button
			variant="outline"
			className="mt-3 w-full"
			disabled={!email || sending}
			onClick={send}
		>
			{sending ? (
				<LoaderCircle className="animate-spin" />
			) : email ? (
				<Mail />
			) : (
				<Pencil />
			)}
			{sending
				? "Sending"
				: email
					? sentBefore
						? "Email the invoice again"
						: "Email the invoice"
					: "No email for the invoice"}
		</Button>
	);
}
