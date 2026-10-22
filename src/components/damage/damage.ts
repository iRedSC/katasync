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
	// Every object URL made and not yet revoked, by photo key. Made as a photo
	// is picked, so one still converting when the picker unmounts is owned too.
	const urls = useRef(new Map<number, string>());
	// Set when the picker unmounts: a photo finished after that is not kept.
	const disposed = useRef(false);
	useEffect(() => {
		disposed.current = false;
		return () => {
			disposed.current = true;
			for (const url of urls.current.values()) URL.revokeObjectURL(url);
			urls.current.clear();
		};
	}, []);

	async function add(files: FileList | null) {
		if (!files || files.length === 0) return;
		setProblem(null);
		const list = [...files];
		setShrinking((n) => n + list.length);
		const bad: string[] = [];
		for (const file of list) {
			try {
				const blob = await shrinkPhoto(file);
				if (disposed.current) return;
				const key = nextKey++;
				const url = URL.createObjectURL(blob);
				urls.current.set(key, url);
				setPhotos((ps) => [...ps, { key, url, blob }]);
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

	// Takes photos off the list by key, and revokes their URLs.
	function take(keys: number[]) {
		for (const key of keys) {
			const url = urls.current.get(key);
			if (url) URL.revokeObjectURL(url);
			urls.current.delete(key);
		}
		setPhotos((ps) => ps.filter((p) => !keys.includes(p.key)));
	}

	return {
		photos,
		shrinking,
		problem,
		add,
		remove: (key: number) => take([key]),
		take,
	};
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

// Adds photos to a damage already recorded, in order, stopping at the first
// that fails. Resolves to the keys of the photos that went up, which the
// caller takes off its list, and to what stopped the rest, if anything.
// Resolves to null when the change itself failed; that has been said.
export async function addPhotos(input: {
	damageId: number;
	photos: PickedPhoto[];
	name: string;
	// Which photo is going up.
	onPhoto?: (index: number) => void;
}) {
	const r = await optimism.change({
		send: async () => {
			const up = await uploadDamagePhotos(
				input.damageId,
				input.photos.map((p) => p.blob),
				input.onPhoto,
			);
			const saved = input.photos.slice(0, up.uploaded).map((p) => p.key);
			if (up.error === null) return { saved, problem: null };
			return {
				saved,
				problem:
					saved.length > 0
						? `${plural(saved.length, "photo")} went up, then: ${up.error}`
						: up.error,
			};
		},
	});
	if (!r) return null;
	if (r.value.problem === null)
		toast.success(`Added ${plural(r.value.saved.length, "photo")}`);
	return r.value;
}
