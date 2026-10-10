import { Delete, Minus, Plus, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "#/lib/utils";
import { holdable } from "./use-long-press";

const MAX = 9999;

// Bottom sheet for receiving a different amount than what's left: -/+, a
// number pad, and a confirm button. Over-shipping is allowed, so only a warning.
// On a closed PO it only offers the undo.
export function QuantitySheet({
	title,
	canReceive,
	remaining,
	lastReceipt,
	busy,
	onConfirm,
	onUndo,
	onClose,
}: {
	title: string;
	canReceive: boolean;
	remaining: number;
	// Newest receipt that can still be undone for this line.
	lastReceipt: number | null;
	busy: boolean;
	onConfirm: (quantity: number) => void;
	onUndo: () => void;
	onClose: () => void;
}) {
	const [quantity, setQuantity] = useState(Math.max(remaining, 1));
	// The first digit replaces the suggested number; later ones append.
	const [typed, setTyped] = useState(false);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const digit = (d: number) => {
		setQuantity((q) => Math.min((typed ? q : 0) * 10 + d, MAX));
		setTyped(true);
	};
	const step = (by: number) => {
		setQuantity((q) => Math.min(Math.max(q + by, 1), MAX));
		setTyped(false);
	};

	const valid = quantity >= 1;
	const over = quantity > remaining;

	return (
		<div className="fixed inset-0 z-50 flex flex-col justify-end">
			{/* pointerdown, not click: the finger that opened the sheet lifts
			    over this backdrop and would otherwise close it at once. */}
			<button
				type="button"
				tabIndex={-1}
				aria-label="Close"
				onPointerDown={onClose}
				className="absolute inset-0 bg-black/40"
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className="relative max-h-svh overflow-y-auto overscroll-contain rounded-t-3xl bg-card px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
			>
				<div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-[#e3e3e3]" />
				<p className="truncate text-center text-base font-semibold">{title}</p>

				{canReceive && (
					<>
						<div className="mt-2 flex items-center gap-3">
							<StepButton label="Less" onClick={() => step(-1)}>
								<Minus className="size-8" />
							</StepButton>
							<div
								className={cn(
									"flex-1 text-center text-6xl font-bold tabular-nums",
									!valid && "text-muted-foreground",
								)}
							>
								{quantity}
							</div>
							<StepButton label="More" onClick={() => step(1)}>
								<Plus className="size-8" />
							</StepButton>
						</div>
						<p
							className={cn(
								"h-6 text-center text-base font-semibold text-warning-text",
								!over && "invisible",
							)}
						>
							More than ordered
						</p>

						<div className="mt-1 grid grid-cols-3 gap-2">
							{[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
								<PadKey key={d} onClick={() => digit(d)}>
									{d}
								</PadKey>
							))}
							<PadKey
								label="Clear"
								onClick={() => {
									setQuantity(0);
									setTyped(true);
								}}
								className="text-lg text-muted-foreground"
							>
								Clear
							</PadKey>
							<PadKey onClick={() => digit(0)}>0</PadKey>
							<PadKey
								label="Backspace"
								onClick={() => {
									setQuantity((q) => Math.floor(q / 10));
									setTyped(true);
								}}
								className="text-muted-foreground"
							>
								<Delete className="size-7" />
							</PadKey>
						</div>

						<button
							type="button"
							disabled={!valid || busy}
							onClick={() => onConfirm(quantity)}
							className="mt-3 h-16 w-full rounded-2xl bg-[#303030] text-xl font-bold text-white active:bg-[#1a1a1a] disabled:opacity-40"
						>
							{valid ? `Receive ${quantity}` : "Pick a number"}
						</button>
					</>
				)}

				{lastReceipt === null && !canReceive && (
					<p className="py-6 text-center text-lg text-muted-foreground">
						Nothing to undo
					</p>
				)}
				{lastReceipt !== null && (
					<button
						type="button"
						disabled={busy}
						onClick={onUndo}
						className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-lg font-semibold text-muted-foreground active:bg-[#f1f1f1] disabled:opacity-40"
					>
						<Undo2 className="size-5" />
						Undo last receipt ({lastReceipt})
					</button>
				)}
			</div>
		</div>
	);
}

function StepButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={onClick}
			className={cn(
				holdable,
				"flex size-16 shrink-0 items-center justify-center rounded-full bg-[#f1f1f1] active:bg-[#e3e3e3]",
			)}
		>
			{children}
		</button>
	);
}

function PadKey({
	label,
	onClick,
	className,
	children,
}: {
	label?: string;
	onClick: () => void;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={onClick}
			className={cn(
				holdable,
				"flex h-14 items-center justify-center rounded-2xl bg-[#f7f7f7] text-2xl font-semibold active:bg-[#e3e3e3]",
				className,
			)}
		>
			{children}
		</button>
	);
}
