import { type Address, getRates, type Parcel } from "./shippo";

// Most Shippo requests in flight for one preview, across all its boxes and
// extras.
const IN_FLIGHT = 4;

// A box to price: its size and weight, whether it's declared as aerosols, and
// the insurance amount it would carry if insured.
export type BoxToQuote = Parcel & {
	hazmat: boolean;
	insureAmount: number | null;
};

// Runs each job at most `max` at a time. Jobs start in the order they were
// asked for; a finished job hands its slot to the next one waiting.
function slots(max: number) {
	let running = 0;
	const waiting: (() => void)[] = [];
	return async <T>(job: () => Promise<T>): Promise<T> => {
		if (running < max) running++;
		else await new Promise<void>((go) => waiting.push(go));
		try {
			return await job();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else running--;
		}
	};
}

// Prices boxes shipped to one address. A box priced already in this request
// isn't sent again: identical boxes with the same extras share one answer,
// and each box still gets its own total.
export function boxQuoter(addresses: { from: Address; to: Address }) {
	const asked = new Map<string, ReturnType<typeof getRates>>();
	const turn = slots(IN_FLIGHT);
	return (box: BoxToQuote, insure: boolean, signature: boolean) => {
		const insureAmount = insure ? box.insureAmount : null;
		// Only what Shippo is sent, so boxes that differ in other fields still
		// match.
		const key = JSON.stringify([
			box.lengthMm,
			box.widthMm,
			box.heightMm,
			box.weightGrams,
			box.hazmat,
			insureAmount,
			signature,
		]);
		let pending = asked.get(key);
		if (!pending) {
			pending = turn(() =>
				getRates({
					...addresses,
					parcel: box,
					insureAmount,
					signature,
					hazmat: box.hazmat,
				}),
			);
			asked.set(key, pending);
		}
		return pending;
	};
}
