import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { shake } from "#/components/shake";
import { formatMoney } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { ChargeKind } from "#/purchasing/landed";
import {
	addPurchaseOrderCharge,
	type PurchaseOrderDetail,
	removePurchaseOrderCharge,
} from "#/server/purchasing";
import { poData } from "./po-data";

type Charge = PurchaseOrderDetail["charges"][number];

const KINDS: { kind: ChargeKind; label: string }[] = [
	{ kind: "freight", label: "Freight" },
	{ kind: "duty", label: "Duty" },
	{ kind: "fee", label: "Fee" },
	{ kind: "credit", label: "Credit" },
];
const labelOf = (kind: ChargeKind) =>
	KINDS.find((k) => k.kind === kind)?.label ?? kind;

// Whole cents over $0, from what was typed ("$1,234.50" too).
function cents(s: string) {
	const t = s.replace(/[$,\s]/g, "");
	if (!/^\d*\.?\d{0,2}$/.test(t) || t === "" || t === ".") return null;
	const n = Number(t);
	return n > 0 ? n : null;
}

// What the PO costs beyond its lines, each part of what its items cost once
// they're in. Says how they're spread, since that sets every item's cost.
export function ChargesRow({ detail: d }: { detail: PurchaseOrderDetail }) {
	const po = d.order;
	const [adding, setAdding] = useState(false);
	const [kind, setKind] = useState<ChargeKind>("freight");
	const [amount, setAmount] = useState("");
	const [wrong, setWrong] = useState(false);
	const field = useRef<HTMLInputElement>(null);
	if (po.status === "suggested" || po.status === "cancelled") return null;
	if (d.charges.length === 0 && !adding)
		return (
			<button
				type="button"
				onClick={() => setAdding(true)}
				className="flex items-center gap-1 px-4 py-2 text-muted-foreground hover:text-foreground"
			>
				<Plus className="size-4" /> Freight, duty, fees
			</button>
		);

	function add() {
		const value = cents(amount);
		if (value === null) {
			setWrong(true);
			shake(field.current);
			return;
		}
		const temp: Charge = {
			id: -Date.now(),
			purchaseOrderId: po.id,
			kind,
			amount: kind === "credit" ? -value : value,
			createdAt: new Date(),
		};
		setAmount("");
		setAdding(false);
		void optimism.change({
			label: `Adding ${labelOf(kind).toLowerCase()}`,
			patch: poData.patch(po.id, (data) => ({
				...data,
				charges: [...data.charges, temp],
			})),
			send: () =>
				addPurchaseOrderCharge({
					data: { purchaseOrderId: po.id, kind, amount: value },
				}),
		});
	}

	async function remove(c: Charge) {
		const r = await optimism.change({
			label: `Removing ${labelOf(c.kind).toLowerCase()}`,
			patch: poData.patch(po.id, (data) => ({
				...data,
				charges: data.charges.filter((x) => x.id !== c.id),
			})),
			send: () => removePurchaseOrderCharge({ data: { id: c.id } }),
		});
		if (!r) return;
		offerUndo(
			`Took ${formatMoney(Math.abs(c.amount))} ${labelOf(c.kind).toLowerCase()} off`,
			{
				undo: async () =>
					(await optimism.change({
						label: `Putting ${labelOf(c.kind).toLowerCase()} back`,
						patch: [],
						send: () => addPurchaseOrderCharge({ data: r.value }),
					})) && `${labelOf(c.kind)} is back`,
			},
		);
	}

	const spread =
		d.split.method === "weight"
			? "Spread by weight"
			: d.split.method === "value"
				? `Spread by value${d.split.unweighed > 0 ? ` · ${d.split.unweighed} without a weight` : ""}`
				: "Spread evenly";

	return (
		<div className="flex flex-wrap items-center gap-2 border-t px-4 py-2">
			{d.charges.map((c) => (
				<span
					key={c.id}
					className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 tabular-nums"
				>
					{labelOf(c.kind)} {formatMoney(c.amount)}
					<button
						type="button"
						aria-label={`Remove ${labelOf(c.kind).toLowerCase()}`}
						onClick={() => remove(c)}
						className="text-muted-foreground hover:text-foreground"
					>
						<X className="size-3.5" />
					</button>
				</span>
			))}
			{adding ? (
				<form
					className="flex items-center gap-1"
					onSubmit={(e) => {
						e.preventDefault();
						add();
					}}
					// Leaving it empty puts it away; picking a kind doesn't.
					onBlur={(e) => {
						if (!e.currentTarget.contains(e.relatedTarget) && !amount.trim())
							setAdding(false);
					}}
				>
					<select
						value={kind}
						onChange={(e) => setKind(e.target.value as ChargeKind)}
						className="h-7 rounded-lg border border-input px-1"
					>
						{KINDS.map((k) => (
							<option key={k.kind} value={k.kind}>
								{k.label}
							</option>
						))}
					</select>
					<input
						ref={field}
						// biome-ignore lint/a11y/noAutofocus: opened to type into
						autoFocus
						inputMode="decimal"
						placeholder="$0.00"
						value={amount}
						onChange={(e) => {
							setAmount(e.target.value);
							setWrong(false);
						}}
						onKeyDown={(e) => {
							if (e.key === "Escape") setAdding(false);
						}}
						className={cn(
							"h-7 w-24 rounded-lg border border-input px-2 tabular-nums outline-none focus:border-ring",
							wrong && "border-critical-border ring-2 ring-critical-border/40",
						)}
					/>
				</form>
			) : (
				<button
					type="button"
					aria-label="Add freight, duty, or a fee"
					onClick={() => setAdding(true)}
					className="text-muted-foreground hover:text-foreground"
				>
					<Plus className="size-4" />
				</button>
			)}
			{d.charges.length > 0 && (
				<span className="ml-auto text-muted-foreground">{spread}</span>
			)}
		</div>
	);
}
