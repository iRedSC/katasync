import type {
	listPackages,
	quickShipBuy,
	quickShipLookup,
	quickShipRates,
} from "#/server/shipping";

export type Found = NonNullable<Awaited<ReturnType<typeof quickShipLookup>>>;
export type Box = Awaited<ReturnType<typeof listPackages>>[number];
export type Dims = { lengthMm: number; widthMm: number; heightMm: number };
// A box already packed and weighed, before buying. hazmat: aerosols inside.
export type Packed = {
	box: Box | null;
	dims: Dims;
	weightGrams: number;
	hazmat: boolean;
};
export type Step = "pin" | "package" | "weight" | "rates" | "done";
// What the label adds beyond postage, chosen on the rates step.
export type Extras = { insure: number | null; signature: boolean };
// A service's price, with what insurance and a signature add to it.
export type Quote = Awaited<ReturnType<typeof quickShipRates>>["rates"][number];
export type Rates = { list: Quote[]; notes: string[]; test: boolean };
export type Bought = Awaited<ReturnType<typeof quickShipBuy>>;
