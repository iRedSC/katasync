import type { Dims } from "./types";
import { inches, lbOz } from "./units";

// A packed box in the units Seller Central's Buy Shipping form takes, at
// the precision quick ship shows: what was on screen here is what's typed
// there. Rides in the form's address after the #, which Amazon is never
// sent; the extension (extension/amazon-buy-shipping) reads it and fills
// the form. Change the shape and v changes with it, so an extension that
// doesn't know the new shape fills nothing rather than something wrong.
export type FormPackage = {
	v: 1;
	// Length, width, height.
	in: [number, number, number];
	lb: number;
	oz: number;
	hazmat: boolean;
};

export function formPackage(packed: {
	dims: Dims;
	weightGrams: number;
	hazmat: boolean;
}): FormPackage {
	const { dims } = packed;
	return {
		v: 1,
		in: [inches(dims.lengthMm), inches(dims.widthMm), inches(dims.heightMm)],
		...lbOz(packed.weightGrams),
		hazmat: packed.hazmat,
	};
}

export const packageFormUrl = (
	formUrl: string,
	packed: Parameters<typeof formPackage>[0],
) =>
	`${formUrl}#katasync=${encodeURIComponent(JSON.stringify(formPackage(packed)))}`;
