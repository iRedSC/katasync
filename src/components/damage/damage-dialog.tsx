import { Camera, Minus, Plus, X } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { cn } from "#/lib/utils";
import {
	addPhotos,
	type DamageKind,
	kindWord,
	needsDescription,
	type PickedPhoto,
	saveDamage,
	usePickedPhotos,
} from "./damage";

// What a damage dialog is for: recording new damage, or missing items, on a
// line, or adding photos to damage already recorded.
export type DamageTarget =
	| {
			kind: "new";
			damage: DamageKind;
			lineId: number;
			name: string;
			// Single items that arrived and aren't damaged yet.
			available: number;
			// The line's unit, when it isn't single items.
			unit: string | null;
	  }
	| { kind: "photos"; damageId: number; name: string };

// Records items that arrived damaged: how many, what's wrong, and photos.
// Saving waits for the photos to upload, and says how far it's got.
// Closing with something entered asks first.
export function DamageDialog({
	target,
	onClose,
}: {
	target: DamageTarget;
	onClose: () => void;
}) {
	const [quantity, setQuantity] = useState(1);
	const [description, setDescription] = useState("");
	const picked = usePickedPhotos();
	const [uploading, setUploading] = useState<number | null>(null);
	const [saving, setSaving] = useState(false);
	// Why adding photos stopped. The ones before it went up and left the list.
	const [failure, setFailure] = useState<string | null>(null);

	const isNew = target.kind === "new";
	const max = isNew ? target.available : 0;
	const word = isNew ? kindWord(target.damage) : "damaged";
	const entered = description.trim() !== "" || picked.photos.length > 0;
	const why = saving
		? null
		: picked.shrinking > 0
			? "Getting photos ready…"
			: isNew && needsDescription(target.damage) && !description.trim()
				? "Say what's wrong"
				: !isNew && picked.photos.length === 0
					? "Pick a photo"
					: null;

	function close() {
		if (saving) return;
		if (entered && !confirm(`Throw away these ${word} items?`)) return;
		onClose();
	}

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (why) return;
		setSaving(true);
		setFailure(null);
		let ok = false;
		if (target.kind === "new") {
			ok = await saveDamage({
				lineId: target.lineId,
				quantity,
				kind: target.damage,
				description: description.trim(),
				photos: picked.photos.map((p) => p.blob),
				name: target.name,
				onPhoto: setUploading,
			});
		} else {
			const up = await addPhotos({
				damageId: target.damageId,
				photos: picked.photos,
				name: target.name,
				onPhoto: setUploading,
			});
			// A retry sends only the photos still on the list.
			if (up) picked.take(up.saved);
			setFailure(up?.problem ?? null);
			ok = up !== null && up.problem === null;
		}
		setSaving(false);
		setUploading(null);
		if (ok) onClose();
	}

	const label = !saving
		? isNew
			? `Record ${quantity} ${word}`
			: "Add photos"
		: uploading !== null
			? `Uploading photo ${uploading + 1} of ${picked.photos.length}…`
			: "Saving…";

	return (
		<Dialog open onOpenChange={(open) => !open && close()}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={submit} className="flex flex-col gap-5">
					<DialogHeader>
						<DialogTitle>
							{!isNew
								? "Add photos"
								: target.damage === "missing"
									? "Missing from the delivery"
									: "Arrived damaged"}
						</DialogTitle>
						<DialogDescription>
							{target.name}
							{isNew && ". These come off the shelf now."}
						</DialogDescription>
					</DialogHeader>

					{isNew && (
						<>
							<div className="flex items-center gap-3">
								<Button
									type="button"
									size="icon"
									variant="outline"
									aria-label="Fewer"
									disabled={quantity <= 1}
									onClick={() => setQuantity((q) => Math.max(1, q - 1))}
								>
									<Minus />
								</Button>
								<input
									type="number"
									inputMode="numeric"
									min={1}
									max={max}
									value={quantity}
									onChange={(e) =>
										setQuantity(
											Math.min(
												max,
												Math.max(1, Math.floor(Number(e.target.value) || 1)),
											),
										)
									}
									className="h-10 w-20 rounded-lg bg-white text-center shadow-card text-2xl font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
									aria-label={`How many are ${word}`}
								/>
								<Button
									type="button"
									size="icon"
									variant="outline"
									aria-label="More"
									disabled={quantity >= max}
									onClick={() => setQuantity((q) => Math.min(max, q + 1))}
								>
									<Plus />
								</Button>
								<span className="text-sm text-muted-foreground">
									of {max}
									{target.unit
										? ` single items, not ${target.unit}s`
										: " that arrived"}
								</span>
							</div>
							<textarea
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								rows={3}
								placeholder={
									target.damage === "missing"
										? "Note for the supplier, if any, e.g. case had 10"
										: "What's wrong, for the supplier, e.g. crushed box, two handles snapped"
								}
								className="w-full resize-none rounded-lg bg-white p-3 shadow-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
							/>
						</>
					)}

					<PhotoPicker picked={picked} disabled={saving} />

					{failure && <p className="text-sm text-critical-text">{failure}</p>}

					<DialogFooter className="gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={saving}
							onClick={close}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={Boolean(why) || saving}>
							{why ?? label}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// Thumbnails of the photos picked, each removable, and a button to pick
// more. On a phone the picker offers the camera.
export function PhotoPicker({
	picked,
	disabled,
	large = false,
}: {
	picked: ReturnType<typeof usePickedPhotos>;
	disabled: boolean;
	large?: boolean;
}) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap gap-2">
				{picked.photos.map((p: PickedPhoto) => (
					<div key={p.key} className="relative">
						<img
							src={p.url}
							alt=""
							className={cn(
								"rounded-lg bg-surface-strong object-cover",
								large ? "size-24" : "size-20",
							)}
						/>
						<button
							type="button"
							aria-label="Remove photo"
							disabled={disabled}
							onClick={() => picked.remove(p.key)}
							className="absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-foreground text-background shadow-card disabled:opacity-40"
						>
							<X className="size-4" />
						</button>
					</div>
				))}
				<button
					type="button"
					disabled={disabled}
					onClick={() => input.current?.click()}
					className={cn(
						"flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-muted-foreground active:bg-surface-strong disabled:opacity-40",
						large ? "size-24 text-base" : "size-20 text-xs hover:bg-subtle",
					)}
				>
					<Camera className={large ? "size-7" : "size-5"} />
					{picked.shrinking > 0 ? "Reading…" : "Add photo"}
				</button>
			</div>
			<input
				ref={input}
				type="file"
				accept="image/*"
				multiple
				hidden
				onChange={(e) => {
					void picked.add(e.target.files);
					e.target.value = "";
				}}
			/>
			{picked.problem && (
				<p className="text-sm text-critical-text">{picked.problem}</p>
			)}
		</div>
	);
}
