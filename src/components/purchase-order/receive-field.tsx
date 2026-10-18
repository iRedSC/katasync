import { useState } from "react";
import { Button } from "#/components/ui/button";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import { field } from "./inline-fields";
import { receiveWithUndo } from "./line-actions";
import type { Line } from "./types";

// Receive from the desk: the remaining count is filled in, so Enter takes
// all of it.
export function ReceiveField({
	line,
	purchaseOrderId,
}: {
	line: Line;
	purchaseOrderId: number;
}) {
	const remaining = line.quantity - line.received;
	const [value, setValue] = useState(String(remaining));
	const n = Number(value);
	const valid = Number.isInteger(n) && n > 0;

	function submit() {
		if (!valid) return;
		// What's left after this, filled in for the next box.
		setValue(String(Math.max(remaining - n, 1)));
		receiveWithUndo(line, n, purchaseOrderId);
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
				aria-label={`${line.unit} of ${line.sku} received`}
				onChange={(e) => setValue(e.target.value)}
				className={cn(field, "w-14")}
			/>
			<Button type="submit" size="sm" variant="outline" disabled={!valid}>
				Receive
			</Button>
		</form>
	);
}
