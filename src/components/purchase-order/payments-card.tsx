import { LoaderCircle, Plus, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Card } from "#/components/page";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import { DateInput } from "#/components/ui/calendar";
import { Tip } from "#/components/ui/tooltip";
import { formatDay, formatMoney } from "#/lib/format";
import { useIntent } from "#/lib/intent";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { openCentsOf } from "#/purchasing/invoice-matching";
import type {
	OrderPayables,
	PaymentEvidence,
	PaymentMethod,
} from "#/purchasing/payables";
import {
	applySupplierCredit,
	assertInvoiceHistory,
	recordSupplierPayment,
	reverseSupplierPayment,
	unapplySupplierPayment,
	withdrawInvoiceHistory,
} from "#/server/payables";
import type { PurchaseOrderDetail } from "#/server/purchasing";
import { middayOf, today } from "./days";

type Invoice = OrderPayables["billing"]["invoices"][number];
type PaymentInput = Parameters<typeof recordSupplierPayment>[0]["data"];

const METHODS: { value: PaymentMethod; label: string }[] = [
	{ value: "ach", label: "ACH" },
	{ value: "check", label: "Check" },
	{ value: "card", label: "Card" },
	{ value: "wire", label: "Wire" },
	{ value: "cash", label: "Cash" },
	{ value: "other", label: "Other" },
];

const methodLabel = (m: PaymentMethod) =>
	METHODS.find((x) => x.value === m)?.label ?? m;

const usd = (cents: number) => formatMoney(cents / 100);

function centsFrom(s: string) {
	const t = s.replace(/[$,\s]/g, "");
	return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null;
}

const input =
	"h-8 min-w-0 rounded-lg border border-input bg-background px-2 outline-none focus:border-ring";
const bad = "border-critical-border ring-2 ring-critical-border/40";

export function PaymentsCard({
	detail: d,
	payables,
}: {
	detail: PurchaseOrderDetail;
	payables: OrderPayables;
}) {
	const [paying, setPaying] = useState<number | null>(null);
	const [fresh, setFresh] = useState<string | null>(null);
	const historyIntent = useIntent<{
		invoiceId: number;
		number: string;
		paidCents: number;
	}>();
	const paymentIntent = useIntent<PaymentInput>();
	const creditIntent =
		useIntent<Parameters<typeof applySupplierCredit>[0]["data"][]>();
	useEffect(() => {
		if (!fresh) return;
		const t = setTimeout(() => setFresh(null), 2500);
		return () => clearTimeout(t);
	}, [fresh]);

	if (d.order.status !== "sent" && d.order.status !== "closed") return null;
	const invoices = payables.billing.invoices.filter((i) => i.voided === null);
	if (invoices.length === 0 && payables.payments.length === 0) return null;
	const credit = payables.payments.filter((p) => p.unappliedCents > 0);

	async function applyCredit(inv: Invoice) {
		const result = await creditIntent.run(
			() => {
				let left = openCentsOf(inv.payment);
				return credit.flatMap((payment) => {
					const amountCents = Math.min(left, payment.unappliedCents);
					left -= amountCents;
					return amountCents > 0
						? [
								{
									id: crypto.randomUUID(),
									paymentId: payment.paymentId,
									invoiceId: inv.id,
									amountCents,
								},
							]
						: [];
				});
			},
			async (applications) => {
				for (const data of applications) {
					const result = await optimism.change({
						label: `Applying ${usd(data.amountCents)} credit`,
						patch: [],
						send: () => applySupplierCredit({ data }),
					});
					if (!result) return null;
				}
				return applications[0]?.invoiceId ?? inv.id;
			},
		);
		if (result !== null) setFresh(`invoice-${result}`);
	}

	async function assertHistory(inv: Invoice, paidCents: number) {
		if (
			historyIntent.state.kind !== "idle" &&
			(historyIntent.state.payload.invoiceId !== inv.id ||
				historyIntent.state.payload.paidCents !== paidCents)
		)
			return;
		const r = await historyIntent.run(
			() => ({ invoiceId: inv.id, number: inv.number, paidCents }),
			async (data) => {
				const result = await optimism.change({
					label: `Saving ${data.number}'s history`,
					patch: [],
					send: () =>
						assertInvoiceHistory({
							data: { invoiceId: data.invoiceId, paidCents: data.paidCents },
						}),
				});
				return result ? data : null;
			},
		);
		if (!r) return;
		setFresh(`invoice-${r.invoiceId}`);
		offerUndo(
			`${r.number} ${r.paidCents === 0 ? "was unpaid" : "was paid"} before`,
			{
				undo: async () =>
					(await optimism.change({
						label: `Forgetting ${r.number}'s history`,
						patch: [],
						send: () =>
							withdrawInvoiceHistory({ data: { invoiceId: r.invoiceId } }),
					}))
						? `${r.number}'s history is unknown again`
						: null,
			},
		);
	}

	return (
		<Card
			flush
			title="Payments"
			aside={
				credit.length > 0 && (
					<span className="text-xs text-success-text tabular-nums">
						{usd(payables.unappliedCents)} credit
					</span>
				)
			}
		>
			<ul className="pb-2">
				{invoices.map((inv) => {
					const open = openCentsOf(inv.payment);
					const applications = payables.payments.flatMap((p) =>
						p.applications
							.filter((a) => a.invoiceId === inv.id && a.reversedAt === null)
							.map((a) => ({ ...a, payment: p })),
					);
					return (
						<li
							key={inv.id}
							className={cn(
								"flex flex-col gap-1 px-4 py-1.5 transition-colors duration-700",
								fresh === `invoice-${inv.id}` && "bg-success-fill",
							)}
						>
							<div className="flex items-center gap-3">
								<span className="font-semibold">{inv.number}</span>
								<Balance invoice={inv} />
								<span className="ml-auto flex items-center gap-1">
									{inv.payment.kind === "unknown" && (
										<>
											<span className="text-xs text-muted-foreground">
												Before Katasync:
											</span>
											<Button
												size="xs"
												variant="ghost"
												onClick={() => assertHistory(inv, 0)}
												disabled={
													historyIntent.state.kind !== "idle" &&
													(historyIntent.state.kind === "pending" ||
														historyIntent.state.payload.invoiceId !== inv.id ||
														historyIntent.state.payload.paidCents !== 0)
												}
											>
												Unpaid
											</Button>
											<Button
												size="xs"
												variant="ghost"
												onClick={() => assertHistory(inv, open)}
												disabled={
													historyIntent.state.kind !== "idle" &&
													(historyIntent.state.kind === "pending" ||
														historyIntent.state.payload.invoiceId !== inv.id ||
														historyIntent.state.payload.paidCents !== open)
												}
											>
												{historyIntent.state.kind === "pending" &&
												historyIntent.state.payload.invoiceId === inv.id ? (
													<LoaderCircle className="animate-spin" />
												) : (
													"Paid"
												)}
											</Button>
										</>
									)}
									{open > 0 && credit.length > 0 && (
										<Button
											size="xs"
											variant="ghost"
											disabled={
												creditIntent.state.kind === "pending" ||
												(creditIntent.state.kind === "retry" &&
													creditIntent.state.payload[0]?.invoiceId !== inv.id)
											}
											onClick={() => applyCredit(inv)}
										>
											{creditIntent.state.kind === "pending" &&
												creditIntent.state.payload[0]?.invoiceId === inv.id && (
													<LoaderCircle className="animate-spin" />
												)}
											Use credit
										</Button>
									)}
									{open > 0 && paying !== inv.id && (
										<Button
											size="xs"
											variant="ghost"
											onClick={() => {
												if (paymentIntent.getSnapshot().kind === "idle")
													setPaying(inv.id);
											}}
											disabled={paymentIntent.state.kind !== "idle"}
										>
											<Plus />
											Payment
										</Button>
									)}
								</span>
							</div>
							{applications.map((a) => (
								<Applied
									key={a.id}
									invoice={inv}
									application={a}
									payment={a.payment}
								/>
							))}
							{paying === inv.id && (
								<PaymentForm
									intent={paymentIntent}
									supplierId={payables.supplierId}
									invoice={inv}
									openCents={open}
									onClose={() => {
										if (paymentIntent.getSnapshot().kind === "idle")
											setPaying(null);
									}}
									onRecorded={(id) => {
										setPaying(null);
										setFresh(id);
									}}
								/>
							)}
						</li>
					);
				})}
			</ul>
			{payables.payments.length > 0 && (
				<ul className="border-t py-2">
					{payables.payments.map((p) => (
						<PaymentRow
							key={p.paymentId}
							payment={p}
							fresh={fresh === p.paymentId}
						/>
					))}
				</ul>
			)}
		</Card>
	);
}

function Balance({ invoice: inv }: { invoice: Invoice }) {
	const p = inv.payment;
	switch (p.kind) {
		case "void":
			return null;
		case "paid":
			return <span className="text-success-text">Paid {usd(p.paidCents)}</span>;
		case "partial":
			return (
				<span className="text-warning-text tabular-nums">
					{usd(p.openCents)} of {usd(p.totalCents)} open
				</span>
			);
		case "unpaid":
			return <span className="tabular-nums">{usd(p.totalCents)} open</span>;
		case "unknown":
			return (
				<span className="text-muted-foreground tabular-nums">
					{usd(p.totalCents)}, recorded before payments were kept
				</span>
			);
		default: {
			const unreachable: never = p;
			return unreachable;
		}
	}
}

function Applied({
	invoice: inv,
	application: a,
	payment: p,
}: {
	invoice: Invoice;
	application: PaymentEvidence["applications"][number];
	payment: PaymentEvidence;
}) {
	const intent = useIntent<string>();
	async function unapply() {
		const r = await intent.run(
			() => a.id,
			(applicationId) =>
				optimism.change({
					label: `Taking ${usd(a.amountCents)} off ${inv.number}`,
					patch: [],
					send: () => unapplySupplierPayment({ data: { applicationId } }),
				}),
		);
		if (!r) return;
		const id = crypto.randomUUID();
		offerUndo(`${usd(a.amountCents)} is unapplied credit now`, {
			undo: async () =>
				(await optimism.change({
					label: `Applying ${usd(a.amountCents)} to ${inv.number}`,
					patch: [],
					send: () =>
						applySupplierCredit({
							data: {
								id,
								paymentId: p.paymentId,
								invoiceId: inv.id,
								amountCents: a.amountCents,
							},
						}),
				}))
					? `${usd(a.amountCents)} is on ${inv.number} again`
					: null,
		});
	}
	return (
		<div className="group flex items-center gap-2 pl-3 text-xs text-muted-foreground">
			<span className="tabular-nums text-foreground">{usd(a.amountCents)}</span>
			<span>
				{methodLabel(p.method)} {formatDay(middayOf(p.paidOn))}
				{p.reference && <>, {p.reference}</>}
			</span>
			<Proof />
			<Button
				size="icon-xs"
				variant="ghost"
				aria-label={`Take ${usd(a.amountCents)} off ${inv.number}`}
				className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
				onClick={unapply}
				disabled={intent.state.kind === "pending"}
			>
				{intent.state.kind === "pending" ? (
					<LoaderCircle className="animate-spin" />
				) : (
					<X />
				)}
			</Button>
		</div>
	);
}

function Proof() {
	return (
		<Tip content="Not confirmed by a bank import">
			<span className="rounded-full bg-muted px-1.5">Staff recorded</span>
		</Tip>
	);
}

function PaymentRow({
	payment: p,
	fresh,
}: {
	payment: PaymentEvidence;
	fresh: boolean;
}) {
	const [armed, setArmed] = useState(false);
	const intent = useIntent<string>();
	useEffect(() => {
		if (!armed) return;
		const t = setTimeout(() => setArmed(false), 3000);
		return () => clearTimeout(t);
	}, [armed]);
	const reversed = p.state.kind === "reversed";

	async function reverse() {
		if (!armed) return setArmed(true);
		setArmed(false);
		await intent.run(
			() => p.paymentId,
			(paymentId) =>
				optimism.change({
					label: `Reversing ${usd(p.amountCents)} payment`,
					patch: [],
					send: () => reverseSupplierPayment({ data: { paymentId } }),
				}),
		);
	}

	return (
		<li
			className={cn(
				"group flex items-center gap-2 px-4 py-1 text-xs transition-colors duration-700",
				fresh && "bg-success-fill",
			)}
		>
			<span
				className={cn(
					"tabular-nums",
					reversed && "text-muted-foreground line-through",
				)}
			>
				{usd(p.amountCents)}
			</span>
			<span className="text-muted-foreground">
				{methodLabel(p.method)} {formatDay(middayOf(p.paidOn))}
				{p.reference && <>, {p.reference}</>}
			</span>
			<Proof />
			{p.state.kind === "reversed" ? (
				<span className="text-muted-foreground">Reversed</span>
			) : (
				p.unappliedCents > 0 && (
					<span className="text-success-text tabular-nums">
						{usd(p.unappliedCents)} unapplied
					</span>
				)
			)}
			{!reversed && (
				<Button
					size="xs"
					variant="ghost"
					className={cn(
						"ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
						armed && "bg-critical-fill text-critical-text opacity-100",
					)}
					onClick={reverse}
					disabled={intent.state.kind === "pending"}
				>
					{intent.state.kind === "pending" ? (
						<LoaderCircle className="animate-spin" />
					) : (
						<Undo2 />
					)}
					{armed ? `Reverse ${usd(p.amountCents)}?` : "Reverse"}
				</Button>
			)}
		</li>
	);
}

function PaymentForm({
	intent,
	supplierId,
	invoice: inv,
	openCents,
	onClose,
	onRecorded,
}: {
	intent: ReturnType<typeof useIntent<PaymentInput>>;
	supplierId: number;
	invoice: Invoice;
	openCents: number;
	onClose: () => void;
	onRecorded: (paymentId: string) => void;
}) {
	const [amount, setAmount] = useState((openCents / 100).toFixed(2));
	const [paidOn, setPaidOn] = useState(today);
	const [method, setMethod] = useState<PaymentMethod>("ach");
	const [reference, setReference] = useState("");
	const saving = intent.state.kind === "pending";
	const locked = intent.state.kind !== "idle";
	const form = useRef<HTMLDivElement>(null);
	const cents = centsFrom(amount);
	const extra = cents === null ? 0 : cents - openCents;

	async function record() {
		if (saving) return;
		if (cents === null || cents <= 0) return shake(form.current);
		const r = await intent.run(
			() => ({
				id: crypto.randomUUID(),
				supplierId,
				amountCents: cents,
				paidOn,
				method,
				reference: reference.trim() || null,
				applications: [
					{
						id: crypto.randomUUID(),
						invoiceId: inv.id,
						amountCents: Math.min(cents, openCents),
					},
				],
			}),
			(data) =>
				optimism.change({
					label: `Recording ${usd(cents)} paid`,
					patch: [],
					send: () => recordSupplierPayment({ data }),
				}),
		);
		if (r) onRecorded(r.value.paymentId);
		else shake(form.current);
	}

	return (
		<div ref={form} className="flex flex-wrap items-center gap-2 pl-3">
			<input
				// biome-ignore lint/a11y/noAutofocus: opened by clicking Payment
				autoFocus
				inputMode="decimal"
				aria-label="Amount paid"
				disabled={locked}
				value={amount}
				onChange={(e) => setAmount(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape" && !locked) onClose();
					if (e.key === "Enter") record();
				}}
				className={cn(
					input,
					"w-28 text-right tabular-nums",
					cents === null && bad,
				)}
			/>
			<DateInput
				aria-label="Paid on"
				disabled={locked}
				value={paidOn}
				max={today()}
				onChange={setPaidOn}
			/>
			<select
				aria-label="Method"
				disabled={locked}
				value={method}
				onChange={(e) =>
					setMethod(
						METHODS.find((m) => m.value === e.target.value)?.value ?? method,
					)
				}
				className={input}
			>
				{METHODS.map((m) => (
					<option key={m.value} value={m.value}>
						{m.label}
					</option>
				))}
			</select>
			<input
				aria-label="Check or confirmation number"
				disabled={locked}
				placeholder="Ref"
				value={reference}
				onChange={(e) => setReference(e.target.value)}
				className={cn(input, "w-32 font-mono text-xs")}
			/>
			<Button size="sm" disabled={saving} onClick={record}>
				{saving && <LoaderCircle className="animate-spin" />}
				{intent.state.kind === "retry" ? "Retry" : "Record paid"}
			</Button>
			<Button size="sm" variant="ghost" disabled={locked} onClick={onClose}>
				Cancel
			</Button>
			{extra > 0 && (
				<span className="text-xs text-success-text tabular-nums">
					{usd(extra)} becomes credit
				</span>
			)}
		</div>
	);
}
