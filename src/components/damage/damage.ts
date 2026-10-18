import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ids, optimism } from "#/lib/optimism";
import { shrinkPhoto, uploadDamagePhotos } from "#/lib/photo";
import { offerUndo } from "#/lib/undo";
import {
	recordPurchaseDamage,
	removePurchaseDamage,
} from "#/server/purchasing";

// What the phone sheet and the desktop dialog share: picking photos, and
// saving a damage with them.

export type PickedPhoto = { key: number; url: string; blob: Blob };

let nextKey = 0;

// Photos picked but not uploaded yet, shrunk as they're picked so the
// upload is quick. One the browser can't read is left out and said why.
export function usePickedPhotos() {
	const [photos, setPhotos] = useState<PickedPhoto[]>([]);
	const [shrinking, setShrinking] = useState(0);
	const [problem, setProblem] = useState<string | null>(null);
	const live = useRef(photos);
	live.current = photos;
	useEffect(
		() => () => {
			for (const p of live.current) URL.revokeObjectURL(p.url);
		},
		[],
	);

	async function add(files: FileList | null) {
		if (!files || files.length === 0) return;
		setProblem(null);
		const list = [...files];
		setShrinking((n) => n + list.length);
		const bad: string[] = [];
		for (const file of list) {
			try {
				const blob = await shrinkPhoto(file);
				const photo = { key: nextKey++, url: URL.createObjectURL(blob), blob };
				setPhotos((ps) => [...ps, photo]);
			} catch {
				bad.push(file.name);
			} finally {
				setShrinking((n) => n - 1);
			}
		}
		if (bad.length > 0)
			setProblem(
				`Couldn't read ${bad.join(", ")}. Try a JPEG or PNG, or take it with the camera.`,
			);
	}

	function remove(key: number) {
		setPhotos((ps) => {
			const gone = ps.find((p) => p.key === key);
			if (gone) URL.revokeObjectURL(gone.url);
			return ps.filter((p) => p.key !== key);
		});
	}

	return { photos, shrinking, problem, add, remove };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// Records the damage, then uploads its photos; the page reloads once both
// are in. A photo that fails leaves the damage saved and says so, since the
// items are off the shelf either way. Offers Undo, which puts them back.
export async function saveDamage(input: {
	lineId: number;
	quantity: number;
	description: string;
	photos: Blob[];
	name: string;
	// Which photo is going up.
	onPhoto?: (index: number) => void;
}) {
	const r = await optimism.change({
		send: async () => {
			const { damageId } = await recordPurchaseDamage({
				data: {
					// A line made on the receive page may only have its id from
					// there until the server's comes back.
					lineId: ids.server(input.lineId),
					quantity: input.quantity,
					description: input.description,
				},
			});
			const upload = await uploadDamagePhotos(
				damageId,
				input.photos,
				input.onPhoto,
			);
			return { damageId, ...upload };
		},
	});
	if (!r) return false;
	const { damageId, uploaded, error } = r.value;
	if (error)
		toast.warning(
			`Saved the damage, but ${plural(input.photos.length - uploaded, "photo")} didn't upload: ${error}`,
			{ description: "Add them from the damage on the PO." },
		);
	offerUndo(
		`${plural(input.quantity, "damaged item")} of ${input.name} off the shelf`,
		{
			tone: "success",
			undo: async () => {
				const u = await optimism.change({
					send: () => removePurchaseDamage({ data: { id: damageId } }),
				});
				return u && `${input.name} back on the shelf`;
			},
		},
	);
	return true;
}

// Adds photos to a damage already recorded.
export async function addPhotos(input: {
	damageId: number;
	photos: Blob[];
	name: string;
	// Which photo is going up.
	onPhoto?: (index: number) => void;
}) {
	const r = await optimism.change({
		send: async () => {
			const up = await uploadDamagePhotos(
				input.damageId,
				input.photos,
				input.onPhoto,
			);
			if (up.error)
				throw new Error(
					up.uploaded > 0
						? `${plural(up.uploaded, "photo")} went up, then: ${up.error}`
						: up.error,
				);
			return up;
		},
	});
	if (r) toast.success(`Added ${plural(input.photos.length, "photo")}`);
	return Boolean(r);
}
