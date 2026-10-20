import { Lock, LockOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useNumberLine } from "#/components/number-line";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import { ids } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { amendPurchaseLine, lockLine, setLine } from "#/server/purchasing";
import { amended, refusedByDiscounts, takeOff } from "./line-actions";
import { patchLines } from "./po-data";
import type { Line } from "./types";
import { useAction } from "./use-action";

// Quantity reads as a bold number on a soft fill, so the column scans at a
// glance.
const quantityBox =
	"h-9 w-16 rounded-lg border border-transparent bg-surface px-2 text-right text-[0.9375rem] font-semibold tabular-nums outline-none";

// Locks a draft line's quantity so Update leaves it alone. Shows only while
// the quantity is hovered or focused, or once it's locked, so the column
// stays quiet. It takes its space either way, so nothing shifts.
export function LockToggle({
	line,
	purchaseOrderId,
}: {
	line: Line;
	purchaseOrderId: number;
}) {
	const { save } = useAction();
	const locked = line.locked;
	const Icon = locked ? Lock : LockOpen;
	return (
		<Tip
			content={
				locked
					? "Locked: Update leaves it alone"
					: "Lock so Update leaves it alone"
			}
		>
			<button
				type="button"
				aria-pressed={locked}
				aria-label={`${locked ? "Unlock" : "Lock"} ${line.sku}'s quantity`}
				onClick={() =>
					save({
						label: `${line.sku}'s lock`,
						patch: patchLines(
							purchaseOrderId,
							(l) => l.productId === line.productId,
							(l) => ({ ...l, locked: !locked }),
							{ draftEdit: true },
						),
						send: () =>
							lockLine({
								data: {
									purchaseOrderId,
									productId: line.productId,
									locked: !locked,
								},
							}),
					})
				}
				className={cn(
					"flex size-6 items-center justify-center rounded-md outline-none hover:bg-surface focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
					locked
						? "text-foreground"
						: "text-muted-foreground opacity-0 group-hover/qty:opacity-100 group-focus-within/qty:opacity-100",
				)}
			>
				<Icon aria-hidden className="size-3.5" />
			</button>
		</Tip>
	);
}

// A line's quantity. Click to type a number, or drag sideways for the
// number line. On a draft 0 takes the line off, with Undo. On a sent PO it's
// a change the supplier isn't told about, also with Undo; 0 there means none
// are coming.
// onPreview gets the quantity while it's dragged or typed, and null once the
// page shows it, which a save does at once. `open` (a nonce) opens it for
// typing, and finishing calls onDone.
export function QuantityField({
	line,
	purchaseOrderId,
	draft,
	open,
	onDone,
	onPreview,
}: {
	line: Line;
	purchaseOrderId: number;
	draft: boolean;
	open: number | null;
	// enter: it was left with Enter, so go on to the next product.
	onDone: (enter: boolean) => void;
	onPreview: (quantity: number | null) => void;
}) {
	const { save: saveChange } = useAction();
	const [typing, setTyping] = useState(false);
	const [text, setText] = useState("");
	// Opened by `open`, so Enter goes on to the next product.
	const opened = useRef(false);
	useEffect(() => {
		if (open === null) return;
		opened.current = true;
		setText("");
		setTyping(true);
	}, [open]);

	async function save(quantity: number) {
		if (quantity === line.quantity) return;
		if (!(draft && quantity === 0) && refusedByDiscounts(line, { quantity }))
			return;
		if (!draft) {
			const r = await saveChange({
				label: `${line.sku}'s quantity`,
				patch: patchLines(
					purchaseOrderId,
					(l) => l.id === line.id,
					(l) => ({ ...l, quantity }),
				),
				send: () =>
					amendPurchaseLine({
						data: { lineId: ids.server(line.id), quantity },
					}),
			});
			if (r)
				amended({
					line,
					result: r.value,
					summary: `${line.sku} now ${formatCount(quantity)}, was ${formatCount(line.quantity)}`,
					purchaseOrderId,
				});
			return;
		}
		if (quantity === 0) {
			takeOff(line, purchaseOrderId);
			return;
		}
		saveChange({
			label: `${line.sku}'s quantity`,
			patch: patchLines(
				purchaseOrderId,
				(l) => l.productId === line.productId,
				(l) => ({ ...l, quantity }),
				{ draftEdit: true },
			),
			send: () =>
				setLine({
					data: { purchaseOrderId, productId: line.productId, quantity },
				}),
		});
	}

	const scrub = useNumberLine({ value: line.quantity, onCommit: save });

	const typed = text.trim();
	const previewing = scrub.dragging
		? scrub.shown
		: typing && /^\d+$/.test(typed)
			? Number(typed)
			: null;
	// A ref, so a new callback each render doesn't re-run the effect.
	const report = useRef(onPreview);
	report.current = onPreview;
	useEffect(() => {
		report.current(previewing);
		return () => report.current(null);
	}, [previewing]);

	// Set by Enter just before it leaves the field.
	const entered = useRef(false);
	function finishTyping() {
		setTyping(false);
		// Once done, `open` must not reopen it when the saved quantity
		// remounts the field.
		if (opened.current) onDone(entered.current);
		entered.current = false;
		opened.current = false;
		const value = text.trim();
		if (value === "") return;
		const n = Number(value);
		if (!Number.isInteger(n) || n < 0) {
			toast.error(`"${value}" isn't a whole number`);
			return;
		}
		save(n);
	}

	if (typing)
		return (
			<input
				value={text}
				// biome-ignore lint/a11y/noAutofocus: opened by a click to type
				autoFocus
				inputMode="numeric"
				placeholder={String(line.quantity)}
				aria-label={`Quantity of ${line.sku}`}
				onChange={(e) => setText(e.target.value)}
				onBlur={finishTyping}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						entered.current = true;
						e.currentTarget.blur();
					}
					if (e.key === "Escape") {
						setText("");
						e.stopPropagation();
						e.currentTarget.blur();
					}
				}}
				className={cn(quantityBox, "border-ring bg-white")}
			/>
		);

	return (
		<>
			<Tip content="Drag sideways to adjust">
				<button
					type="button"
					aria-label={`Quantity of ${line.sku}: ${line.quantity}`}
					{...scrub.handlers}
					onClick={() => {
						// A drag's release isn't a click.
						if (scrub.wasDrag()) return;
						setText("");
						setTyping(true);
					}}
					className={cn(
						quantityBox,
						"cursor-pointer select-none hover:bg-surface",
						scrub.dragging && "cursor-ew-resize",
					)}
				>
					{scrub.dragging ? scrub.shown : line.quantity}
				</button>
			</Tip>
			{scrub.line}
		</>
	);
}
