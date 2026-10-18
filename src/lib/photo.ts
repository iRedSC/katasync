// Photos from a phone are 3 to 12 MB, more than a request may carry and far
// more than a supplier needs to see damage. This shrinks one to a JPEG no
// longer than 2000 px on a side, turned the way the camera held it. Browser
// only. Throws when the browser can't read the file (HEIC on Chrome, say).
const LONGEST = 2000;

export async function shrinkPhoto(file: Blob): Promise<Blob> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch {
		throw new Error("This browser can't read that photo");
	}
	const scale = Math.min(1, LONGEST / Math.max(bitmap.width, bitmap.height));
	const width = Math.round(bitmap.width * scale);
	const height = Math.round(bitmap.height * scale);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Couldn't shrink that photo");
	ctx.drawImage(bitmap, 0, 0, width, height);
	bitmap.close();
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, "image/jpeg", 0.85),
	);
	if (!blob) throw new Error("Couldn't shrink that photo");
	return blob;
}

// Uploads photos of a damage one at a time, since a request can only carry
// one comfortably. `onPhoto` hears which one is going up. Says how far it
// got before anything failed.
export async function uploadDamagePhotos(
	damageId: number,
	photos: Blob[],
	onPhoto?: (index: number) => void,
): Promise<{ uploaded: number; error: string | null }> {
	let uploaded = 0;
	for (const photo of photos) {
		onPhoto?.(uploaded);
		const res = await fetch(`/api/damage-photos/${damageId}`, {
			method: "POST",
			headers: { "Content-Type": photo.type || "image/jpeg" },
			body: photo,
		}).catch(() => null);
		if (!res?.ok) {
			const body = (await res?.json().catch(() => null)) as {
				error?: string;
			} | null;
			return {
				uploaded,
				error: body?.error ?? (res ? res.statusText : "No connection"),
			};
		}
		uploaded++;
	}
	return { uploaded, error: null };
}
