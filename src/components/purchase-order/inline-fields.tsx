import { Asterisk } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Tip } from "#/components/ui/tooltip";
import { formatMoney } from "#/lib/format";
import { ids } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import {
	amendPurchaseLine,
	setLine,
	setProductSupplier,
} from "#/server/purchasing";
import { amended, refusedByDiscounts } from "./line-actions";
import { patchLines } from "./po-data";
import type { Line } from "./types";
import { useAction } from "./use-action";

// Under a sent line's quantity or cost, when it has changed since: what the
// supplier was sent, which is what the PDF still shows.
export function WasSent({
	line,
	shows,
	was,
}: {
	line: Line;
	shows: boolean;
	was: string;
}) {
	if (line.sentQuantity === null || !shows) return null;
	const tip = `${was}. The PDF still shows this.`;
	return (
		<Tip content={tip}>
			<span
				role="img"
				aria-label={tip}
				className="inline-flex cursor-help text-warning-text"
			>
				<Asterisk aria-hidden className="size-5" strokeWidth={2.75} />
			</span>
		</Tip>
	);
}

export const field =
	"h-8 rounded-lg border border-input bg-white px-2 text-right tabular-nums outline-none focus:border-ring";

// Reads as text with a dotted underline, like everything else that can be
// changed, until clicked. Its box is a fixed size either way, so editing
// doesn't push the columns around. Saves on Enter or leaving the field;
// Escape puts the old text back. Shows what was typed until the saved value
// comes back.
function InlineField({
	shown,
	initial,
	placeholder,
	label,
	inputMode,
	align = "left",
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
	align?: "left" | "right";
	// Sets the width.
	className: string;
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

	const text = pending ?? (initial === "" ? "" : shown);
	return (
		<span
			className={cn(
				"relative inline-flex h-8 items-center px-1.5 align-middle",
				align === "right" && "justify-end",
				className,
			)}
		>
			{editing ? (
				<input
					value={value}
					// biome-ignore lint/a11y/noAutofocus: opened by a click to type
					autoFocus
					onFocus={(e) => e.currentTarget.select()}
					placeholder={placeholder}
					aria-label={label}
					inputMode={inputMode}
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
						"absolute inset-0 w-full rounded-md border border-ring bg-white px-[5px] tabular-nums outline-none",
						align === "right" && "text-right",
					)}
				/>
			) : (
				<button
					type="button"
					aria-label={label}
					onClick={() => {
						setValue(pending ?? initial);
						setEditing(true);
					}}
					className={cn(
						"max-w-full cursor-text truncate border-b border-dotted border-faint leading-tight tabular-nums hover:border-foreground",
						text === "" && "text-muted-foreground",
					)}
				>
					{text === "" ? placeholder : text}
				</button>
			)}
		</span>
	);
}

// A line's cost per unit. Empty means no cost yet. On a sent PO it's a change
// the supplier isn't told about.
export function PriceField({
	line,
	purchaseOrderId,
	draft,
}: {
	line: Line;
	purchaseOrderId: number;
	draft: boolean;
}) {
	const { save } = useAction();
	return (
		<InlineField
			shown={formatMoney(line.unitCost)}
			initial={line.unitCost?.toFixed(2) ?? ""}
			placeholder="Add cost"
			label={`Cost of ${line.sku}`}
			inputMode="decimal"
			align="right"
			className="w-24"
			onSave={async (text) => {
				const n = Number(text.replace(/^\$/, ""));
				if (text !== "" && !(Number.isFinite(n) && n >= 0)) {
					toast.error(`"${text}" isn't a cost`);
					return false;
				}
				const unitCost = text === "" ? null : n;
				if (refusedByDiscounts(line, { unitCost })) return false;
				if (!draft) {
					save({
						label: `Cost of ${line.sku}`,
						patch: patchLines(
							purchaseOrderId,
							(l) => l.id === line.id,
							(l) => ({ ...l, unitCost }),
						),
						send: () =>
							amendPurchaseLine({
								data: { lineId: ids.server(line.id), unitCost },
							}),
					}).then(
						(r) =>
							r &&
							amended({
								line,
								result: r.value,
								summary: `${line.sku} now ${formatMoney(unitCost)}, was ${formatMoney(line.unitCost)}`,
								purchaseOrderId,
							}),
					);
					return true;
				}
				save({
					label: `Cost of ${line.sku}`,
					patch: patchLines(
						purchaseOrderId,
						(l) => l.productId === line.productId,
						(l) => ({ ...l, unitCost }),
						{ draftEdit: true },
					),
					send: () =>
						setLine({
							data: {
								purchaseOrderId,
								productId: line.productId,
								quantity: line.quantity,
								unitCost,
							},
						}),
				});
				return true;
			}}
		/>
	);
}

// The supplier's part number for the product, kept on the product, so it
// changes every PO with it. Only this PO's supplier's number can change here.
export function SupplierSkuField({
	line,
	purchaseOrderId,
	supplierId,
}: {
	line: Line;
	purchaseOrderId: number;
	supplierId: number;
}) {
	const { save } = useAction();
	if (line.linkSupplierId !== supplierId)
		return (
			<Tip
				content={
					line.kind === "bundle"
						? "Sets are bought as their parts"
						: line.linkSupplierId === null
							? "No supplier; set one on its page"
							: "Bought from another supplier"
				}
			>
				<span className="px-1.5 text-muted-foreground">
					{line.supplierSku ?? "—"}
				</span>
			</Tip>
		);
	return (
		<InlineField
			shown={line.supplierSku ?? ""}
			initial={line.supplierSku ?? ""}
			placeholder="Add"
			label={`${line.sku}'s supplier SKU`}
			className="w-32"
			onSave={async (text) => {
				const supplierSku = text === "" ? null : text;
				save({
					label: `${line.sku}'s supplier SKU`,
					patch: patchLines(
						purchaseOrderId,
						(l) => l.productId === line.productId,
						(l) => ({ ...l, supplierSku }),
					),
					send: () =>
						setProductSupplier({
							data: { productId: line.productId, supplierId, supplierSku },
						}),
				});
				return true;
			}}
		/>
	);
}
