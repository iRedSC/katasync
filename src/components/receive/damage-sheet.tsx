import { Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	type DamageKind,
	kindWord,
	needsDescription,
	saveDamage,
	usePickedPhotos,
} from "#/components/damage/damage";
import { PhotoPicker } from "#/components/damage/damage-dialog";
import { cn } from "#/lib/utils";
import { holdable } from "./use-long-press";

// The phone's way to record damage, or items missing from what came: how
// many, what's wrong, and photos from the camera. Big targets, like the rest of receiving. Saving waits for the
// photos to go up and says how far it's got; closing with something entered
// asks first.
export function DamageSheet({
	title,
	kind,
	lineId,
	available,
	unit,
	onClose,
}: {
	title: string;
	kind: DamageKind;
	lineId: number;
	// Single items that arrived and aren't damaged yet.
	available: number;
	// The line's unit, when it isn't single items.
	unit?: string;
	onClose: () => void;
}) {
	const [quantity, setQuantity] = useState(1);
	const [description, setDescription] = useState("");
	const picked = usePickedPhotos();
	const [saving, setSaving] = useState(false);
	const [uploading, setUploading] = useState<number | null>(null);
	const entered = description.trim() !== "" || picked.photos.length > 0;

	const close = () => {
		if (saving) return;
		if (entered && !confirm(`Throw away these ${kindWord(kind)} items?`))
			return;
		onClose();
	};
	const closeRef = useRef(close);
	closeRef.current = close;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) =>
			e.key === "Escape" && closeRef.current();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const why =
		picked.shrinking > 0
			? "Getting photos ready…"
			: needsDescription(kind) && !description.trim()
				? "Say what's wrong"
				: null;

	async function save() {
		if (why || saving) return;
		setSaving(true);
		const ok = await saveDamage({
			lineId,
			quantity,
			kind,
			description: description.trim(),
			photos: picked.photos.map((p) => p.blob),
			name: title,
			onPhoto: setUploading,
		});
		setSaving(false);
		setUploading(null);
		if (ok) onClose();
	}

	return (
		<div className="fixed inset-0 z-50 flex flex-col justify-end">
			<button
				type="button"
				tabIndex={-1}
				aria-label="Close"
				onPointerDown={close}
				className="absolute inset-0 bg-black/40"
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={`${kind === "missing" ? "Missing" : "Damaged"} ${title}`}
				className="relative max-h-svh overflow-y-auto overscroll-contain rounded-t-3xl bg-card px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
			>
				<div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-surface-strong" />
				<p className="truncate text-center text-base font-semibold">{title}</p>
				<p className="text-center text-sm text-muted-foreground">
					{kind === "missing" ? "Not in the box." : "Arrived damaged."} They
					come off the shelf.
				</p>

				<div className="mt-3 flex items-center gap-3">
					<StepButton
						label="Fewer"
						disabled={saving || quantity <= 1}
						onClick={() => setQuantity((q) => Math.max(1, q - 1))}
					>
						<Minus className="size-8" />
					</StepButton>
					<div className="flex-1 text-center">
						<p className="text-6xl font-bold tabular-nums">{quantity}</p>
						<p className="text-sm text-muted-foreground">
							of {available}
							{unit ? ` single items, not ${unit}s` : ""}
						</p>
					</div>
					<StepButton
						label="More"
						disabled={saving || quantity >= available}
						onClick={() => setQuantity((q) => Math.min(available, q + 1))}
					>
						<Plus className="size-8" />
					</StepButton>
				</div>

				<textarea
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					disabled={saving}
					rows={3}
					placeholder={
						kind === "missing"
							? "Note for the supplier, if any, e.g. case had 10"
							: "What's wrong, e.g. crushed box, two handles snapped"
					}
					className="mt-4 w-full resize-none rounded-2xl bg-subtle p-3 text-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
				/>

				<div className="mt-3">
					<PhotoPicker picked={picked} disabled={saving} large />
				</div>

				<button
					type="button"
					disabled={Boolean(why) || saving}
					onClick={save}
					className="mt-4 h-16 w-full rounded-2xl bg-primary text-xl font-bold text-white active:bg-primary-hover disabled:opacity-40"
				>
					{saving
						? uploading !== null
							? `Uploading photo ${uploading + 1} of ${picked.photos.length}…`
							: "Saving…"
						: (why ?? `${quantity} ${kindWord(kind)}`)}
				</button>
			</div>
		</div>
	);
}

function StepButton({
	label,
	disabled,
	onClick,
	children,
}: {
	label: string;
	disabled: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				holdable,
				"flex size-16 shrink-0 items-center justify-center rounded-full bg-surface active:bg-surface-strong disabled:opacity-40",
			)}
		>
			{children}
		</button>
	);
}
