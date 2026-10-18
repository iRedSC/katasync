import { Delete, Minus, Plus, ShieldAlert, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "#/lib/utils";
import { holdable } from "./use-long-press";

const MAX = 9999;

// Bottom sheet for receiving a different amount than what's left: -/+, a
// number pad, and a confirm button. More than ordered is kept, and the PO
// then expects it. Less asks whether the rest is still coming; 0 says none
// came. None of it reaches the supplier. On a closed PO it only offers the
// undo. `extra` is a product that isn't on the PO yet. Once some has
// arrived, it can also record some as damaged.
export function QuantitySheet({
	title,
	unit,
	canReceive,
	remaining,
	extra = false,
	lastReceipt,
	onConfirm,
	onNoneCame,
	onUndo,
	onDamaged,
	onClose,
}: {
	title: string;
	// What's counted when it isn't one of the product, e.g. "CASE".
	unit?: string;
	canReceive: boolean;
	remaining: number;
	extra?: boolean;
	// Newest receipt that can still be undone for this line.
	lastReceipt: number | null;
	// last: nothing more of it is coming.
	onConfirm: (quantity: number, last: boolean) => void;
	// Stop waiting for what's left without receiving any.
	onNoneCame?: () => void;
	onUndo: () => void;
	// Some of what arrived is damaged; absent when nothing arrived yet.
	onDamaged?: () => void;
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
	const canStop = Boolean(onNoneCame) && remaining > 0;
	const step = (by: number) => {
		setQuantity((q) => Math.min(Math.max(q + by, canStop ? 0 : 1), MAX));
		setTyped(false);
	};

	const valid = quantity >= 1 || (quantity === 0 && canStop);
	const over = !extra && quantity > remaining;
	const short = quantity >= 1 && quantity < remaining;
	const u = unit ? ` ${unit}` : "";

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
				<div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-surface-strong" />
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
								"min-h-6 text-center text-base font-semibold text-warning-text",
								!(over || extra) && "invisible",
							)}
						>
							{extra
								? "Not on the PO. Gets added."
								: "More than ordered. PO keeps the extra."}
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
							disabled={!valid}
							onClick={() =>
								quantity === 0 ? onNoneCame?.() : onConfirm(quantity, false)
							}
							className="mt-3 h-16 w-full rounded-2xl bg-primary text-xl font-bold text-white active:bg-primary-hover disabled:opacity-40"
						>
							{!valid
								? "Pick a number"
								: quantity === 0
									? "None came, stop waiting"
									: short
										? `Receive ${quantity}${u}, rest still coming`
										: `Receive ${quantity}${u}`}
						</button>
						{short && (
							<button
								type="button"
								onClick={() => onConfirm(quantity, true)}
								className="mt-2 h-16 w-full rounded-2xl bg-surface text-xl font-bold active:bg-surface-strong"
							>
								Receive {quantity}
								{u}, that's all they sent
							</button>
						)}
					</>
				)}

				{onDamaged && (
					<button
						type="button"
						onClick={onDamaged}
						className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-lg font-semibold text-critical-text active:bg-critical-surface"
					>
						<ShieldAlert className="size-5" />
						Some arrived damaged
					</button>
				)}
				{lastReceipt === null && !canReceive && !onDamaged && (
					<p className="py-6 text-center text-lg text-muted-foreground">
						Nothing to undo
					</p>
				)}
				{lastReceipt !== null && (
					<button
						type="button"
						onClick={onUndo}
						className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-lg font-semibold text-muted-foreground active:bg-surface"
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
				"flex size-16 shrink-0 items-center justify-center rounded-full bg-surface active:bg-surface-strong",
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
				"flex h-14 items-center justify-center rounded-2xl bg-subtle text-2xl font-semibold active:bg-surface-strong",
				className,
			)}
		>
			{children}
		</button>
	);
}
