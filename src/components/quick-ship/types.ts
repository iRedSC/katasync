import type {
	listPackages,
	quickShipBuy,
	quickShipLookup,
} from "#/server/shipping";
import type { Rate } from "#/shipping/shippo";

export type Found = NonNullable<Awaited<ReturnType<typeof quickShipLookup>>>;
export type Box = Awaited<ReturnType<typeof listPackages>>[number];
export type Dims = { lengthMm: number; widthMm: number; heightMm: number };
// A box already packed and weighed, before buying.
export type Packed = { box: Box | null; dims: Dims; weightGrams: number };
export type Step = "pin" | "package" | "weight" | "rates" | "done";
// What the label adds beyond postage, chosen on the rates step.
export type Extras = { insure: number | null; signature: boolean };
export type Rates = { list: Rate[]; notes: string[]; test: boolean };
export type Bought = Awaited<ReturnType<typeof quickShipBuy>>;
