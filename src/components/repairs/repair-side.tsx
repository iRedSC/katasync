import { ExternalLink, Mail, Pencil } from "lucide-react";
import { useState } from "react";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatMoney, formatPhone } from "#/lib/format";
import { CustomerPicker, type FoundCustomer } from "./customer-picker";
import { NoteField } from "./labor-card";
import type { Detail } from "./repair-data";
import { TechPicker } from "./tech-picker";

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
	editable,
	onSave,
}: {
	d: Detail;
	editable: boolean;
	onSave: (edit: {
		tool?: string;
		serial?: string | null;
		problem?: string;
	}) => void;
}) {
	const r = d.repair;
	const [problem, setProblem] = useState(r.problem);
	return (
		<Card title="Tool">
			<div className="flex flex-col gap-1">
				<div className="-mx-2 text-base font-semibold">
					<NoteField
						value={r.tool}
						disabled={!editable}
						placeholder="Tool"
						onSave={(tool) => tool.trim() && onSave({ tool })}
					/>
				</div>
				<div className="-mx-2 text-muted-foreground">
					<NoteField
						value={r.serial ?? ""}
						disabled={!editable}
						placeholder="Serial"
						onSave={(serial) => onSave({ serial })}
					/>
				</div>
				<textarea
					value={problem}
					disabled={!editable}
					onChange={(e) => setProblem(e.target.value)}
					onBlur={() => problem !== r.problem && onSave({ problem })}
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
	const [notes, setNotes] = useState(d.repair.notes);
	return (
		<Card title="Technician">
			<TechPicker
				people={d.people}
				value={d.repair.technicianId}
				onChange={onTechnician}
			/>
			<textarea
				value={notes}
				onChange={(e) => setNotes(e.target.value)}
				onBlur={() => notes !== d.repair.notes && onNotes(notes)}
				placeholder="Shop notes (not on the order)"
				rows={2}
				className="mt-3 w-full resize-none rounded-lg bg-surface px-3 py-2 outline-none"
			/>
		</Card>
	);
}

export function BillCard({ d, onEmail }: { d: Detail; onEmail: () => void }) {
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
			<Button
				variant="outline"
				className="mt-3 w-full"
				disabled={!r.customerEmail}
				onClick={onEmail}
			>
				{r.customerEmail ? <Mail /> : <Pencil />}
				{r.customerEmail
					? draft.invoiceSentAt
						? "Email the invoice again"
						: "Email the invoice"
					: "No email for the invoice"}
			</Button>
		</Card>
	);
}
