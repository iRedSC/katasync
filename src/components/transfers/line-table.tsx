import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useState } from "react";
import { ProductImage, ProductName } from "#/components/product";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { getTransfer } from "#/server/transfers";

type Loaded = Awaited<ReturnType<typeof getTransfer>>;
export type TransferLine = Loaded["lines"][number];

// A transfer's lines: what each end holds now, and how many move. On a
// draft the quantity is typed in place; 0 takes the line off. A line the
// source can't cover is flagged before anyone presses Send.
export function LineTable({
	lines,
	from,
	to,
	editable,
	onQuantity,
}: {
	lines: TransferLine[];
	from: string;
	to: string;
	editable: boolean;
	onQuantity: (line: TransferLine, quantity: number) => void;
}) {
	return (
		<table className="w-full">
			<thead>
				<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
					<th className="px-4 py-2 font-medium">Product</th>
					<th className="px-4 py-2 text-right font-medium">At {from}</th>
					<th className="px-4 py-2 text-right font-medium">At {to}</th>
					<th className="px-4 py-2 text-right font-medium">Moving</th>
					{editable && <th className="w-10" />}
				</tr>
			</thead>
			<tbody>
				{lines.map((l) => {
					const short = editable && l.quantity > Math.max(0, l.atSource);
					return (
						<tr key={l.productId} className="border-t">
							<td className="px-4 py-2">
								<Link
									to="/products/$sku"
									params={{ sku: l.sku }}
									className="flex items-center gap-3 hover:underline"
								>
									<ProductImage src={l.imageUrl} className="size-8" />
									<div className="min-w-0">
										<ProductName name={l.name} variantName={l.variantName} />
										<div className="text-xs text-muted-foreground">{l.sku}</div>
									</div>
								</Link>
							</td>
							<td
								className={cn(
									"px-4 py-2 text-right tabular-nums",
									short && "font-semibold text-critical-text",
								)}
							>
								{formatCount(l.atSource)}
							</td>
							<td className="px-4 py-2 text-right tabular-nums">
								{formatCount(l.atDestination)}
								{l.target !== null && (
									<span className="text-muted-foreground">
										{" "}
										/ {formatCount(l.target)}
									</span>
								)}
							</td>
							<td className="px-4 py-2 text-right">
								{editable ? (
									<QuantityInput
										value={l.quantity}
										onSave={(q) => onQuantity(l, q)}
									/>
								) : (
									<span className="font-semibold tabular-nums">
										{formatCount(l.quantity)}
									</span>
								)}
							</td>
							{editable && (
								<td className="pr-2">
									<button
										type="button"
										aria-label={`Take ${l.sku} off`}
										onClick={() => onQuantity(l, 0)}
										className="rounded-lg p-1.5 text-muted-foreground hover:bg-surface-strong"
									>
										<X className="size-4" />
									</button>
								</td>
							)}
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

// Saves on Enter or leaving the field; anything that isn't a whole number
// goes back to what it was.
function QuantityInput({
	value,
	onSave,
}: {
	value: number;
	onSave: (quantity: number) => void;
}) {
	const [text, setText] = useState(String(value));
	const [was, setWas] = useState(value);
	if (was !== value) {
		setWas(value);
		setText(String(value));
	}
	function commit() {
		const n = Number(text);
		if (text.trim() === "" || !Number.isInteger(n) || n < 0) {
			setText(String(value));
			return;
		}
		if (n !== value) onSave(n);
	}
	return (
		<input
			value={text}
			inputMode="numeric"
			aria-label="Quantity"
			onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
			}}
			className="h-8 w-16 rounded-lg bg-surface px-2 text-right font-semibold tabular-nums outline-none focus:ring-2 focus:ring-ring"
		/>
	);
}
