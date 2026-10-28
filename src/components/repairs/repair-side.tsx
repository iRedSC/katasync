import { ExternalLink, LoaderCircle, Mail, Pencil } from "lucide-react";
import { useRef, useState } from "react";
import { Card } from "#/components/page";
import type { IndexedProduct } from "#/components/transfers/add-product";
import { Button } from "#/components/ui/button";
import { formatMoney, formatPhone } from "#/lib/format";
import { cn } from "#/lib/utils";
import { CustomerPicker, type FoundCustomer } from "./customer-picker";
import { useDraft } from "./draft";
import { NoteField } from "./labor-card";
import type { Detail } from "./repair-data";
import { TechPicker } from "./tech-picker";
import { ToolInput } from "./tool-input";

// The side of a repair's page: whose it is, what it is, who has it, and
// what it comes to on the draft order.

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

export function ToolCard({
	d,
	products,
	editable,
	onSave,
}: {
	d: Detail;
	products: IndexedProduct[];
	editable: boolean;
	onSave: (edit: {
		tool?: string;
		productId?: number | null;
		serial?: string | null;
		problem?: string;
	}) => void;
}) {
	const r = d.repair;
	const bench = r.kind === "bench";
	const problem = useDraft(r.problem, `problem-${r.id}`);
	// A bench job stays the product it came in as; its name is a label.
	const named = useDraft(
		{ tool: r.tool, productId: r.productId },
		`tool-${r.id}`,
		(a, b) => a.tool === b.tool && a.productId === b.productId,
	);
	const { tool, productId } = named.value;
	return (
		<Card title="Tool">
			<div className="flex flex-col gap-1">
				<div className="-mx-2 text-base font-semibold">
					<ToolInput
						value={tool}
						productId={productId}
						products={products}
						disabled={!editable}
						onChange={(text, id) =>
							named.type({ tool: text, productId: bench ? productId : id })
						}
						onDone={(t, id) => {
							// A tool can't be blank; clearing it puts the old one back.
							if (!t.trim()) return named.revert();
							// Untouched, it already is what's there, so nothing is written.
							if (bench) {
								if (t !== r.tool) onSave({ tool: t });
							} else if (t !== r.tool || id !== r.productId)
								onSave({ tool: t, productId: id });
						}}
						className={cn(
							"h-8 rounded-lg px-2 focus-within:bg-surface",
							editable && "hover:bg-surface",
						)}
					/>
				</div>
				<div className="-mx-2 text-muted-foreground">
					<NoteField
						id={`serial-${r.id}`}
						value={r.serial ?? ""}
						disabled={!editable}
						placeholder="Serial"
						onSave={(serial) => onSave({ serial })}
					/>
				</div>
				<textarea
					value={problem.value}
					disabled={!editable}
					onChange={(e) => problem.type(e.target.value)}
					onBlur={() => {
						const text = problem.save();
						if (text !== null) onSave({ problem: text });
					}}
					placeholder="What's wrong with it"
					rows={3}
					className="-mx-2 resize-none rounded-lg bg-transparent px-2 py-1 outline-none hover:bg-surface focus:bg-surface disabled:hover:bg-transparent"
				/>
			</div>
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
