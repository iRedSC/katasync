import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CatalogMark } from "#/components/catalog-mark";
import { Tip } from "#/components/ui/tooltip";
import { optimism, type Patch } from "#/lib/optimism";
import { shrinkPhoto } from "#/lib/photo";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { setCatalogPhoto } from "#/server/purchasing";

// Catalog photos show small, so 800 px is plenty and keeps them light.
const LONGEST = 800;

async function upload(file: Blob) {
	const photo = await shrinkPhoto(file, LONGEST);
	const res = await fetch("/api/catalog-photos", {
		method: "POST",
		headers: { "Content-Type": photo.type || "image/jpeg" },
		body: photo,
	}).catch(() => null);
	const body = (await res?.json().catch(() => null)) as {
		photoId?: number;
		error?: string;
	} | null;
	if (!res?.ok || !body?.photoId)
		throw new Error(body?.error ?? "Couldn't upload that photo");
	return body.photoId;
}

// A catalog's photo. Click to pick one, or drop or paste an image on the
// page; the old one comes back with Undo. `patch` shows a photo at once.
export function CatalogPhoto({
	catalog,
	patch,
}: {
	catalog: { id: number; name: string; photoId: number | null };
	patch: (photoId: number | null) => Patch;
}) {
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [over, setOver] = useState(false);

	async function show(photoId: number | null, message: string) {
		const was = catalog.photoId;
		const r = await optimism.change({
			label: message,
			patch: patch(photoId),
			send: () => setCatalogPhoto({ data: { id: catalog.id, photoId } }),
		});
		if (!r) return;
		offerUndo(message, {
			tone: "success",
			undo: async () => {
				const back = await optimism.change({
					label: "Putting the old photo back",
					patch: patch(was),
					send: () =>
						setCatalogPhoto({ data: { id: catalog.id, photoId: was } }),
				});
				return back && "Put the old photo back";
			},
		});
	}

	async function take(file: File | undefined) {
		if (!file?.type.startsWith("image/")) return;
		setBusy(true);
		try {
			await show(await upload(file), "New photo");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	// A pasted image anywhere on the page, outside a field, becomes the photo.
	const latest = useRef(take);
	latest.current = take;
	useEffect(() => {
		const paste = (e: ClipboardEvent) => {
			const t = e.target;
			if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)
				return;
			const file = [...(e.clipboardData?.files ?? [])].find((f) =>
				f.type.startsWith("image/"),
			);
			if (file) {
				e.preventDefault();
				latest.current(file);
			}
		};
		window.addEventListener("paste", paste);
		return () => window.removeEventListener("paste", paste);
	}, []);

	return (
		<div className="group relative w-fit">
			<Tip content="Click, drop, or paste a photo">
				<button
					type="button"
					aria-label={catalog.photoId ? "Change photo" : "Add a photo"}
					disabled={busy}
					onClick={() => input.current?.click()}
					onDragOver={(e) => {
						e.preventDefault();
						setOver(true);
					}}
					onDragLeave={() => setOver(false)}
					onDrop={(e) => {
						e.preventDefault();
						setOver(false);
						take(e.dataTransfer.files[0]);
					}}
					className={cn(
						"relative block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring",
						over && "ring-2 ring-primary ring-offset-2",
					)}
				>
					<CatalogMark catalog={catalog} size="lg" />
					<span
						className={cn(
							"absolute inset-0 flex items-center justify-center rounded-xl bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100",
							(busy || over) && "opacity-100",
						)}
					>
						{busy ? (
							<Loader2 className="size-5 animate-spin" />
						) : (
							<ImagePlus className="size-5" />
						)}
					</span>
				</button>
			</Tip>
			{catalog.photoId !== null && !busy && (
				<button
					type="button"
					aria-label="Remove photo"
					onClick={() => show(null, "Photo removed")}
					className="absolute -top-1.5 -right-1.5 rounded-full bg-card p-1 text-muted-foreground opacity-0 shadow-card transition-opacity group-hover:opacity-100 hover:text-critical-text focus-visible:opacity-100"
				>
					<Trash2 className="size-3.5" />
				</button>
			)}
			<input
				ref={input}
				type="file"
				accept="image/*"
				hidden
				onChange={(e) => {
					take(e.target.files?.[0]);
					e.target.value = "";
				}}
			/>
		</div>
	);
}
