// Labor is billed with Shopify's "Labor @ $55/hr" product, whose variants
// are lengths of time ("15m", "1h 15m", "2h"). Time typed on a repair goes
// on the draft order as the fewest of those that add up to it exactly, so a
// 3h 15m job is a 2h line and a 1h 15m line. Prices are whatever Shopify
// has, so changing the rate there changes it here.

export type LaborVariant = {
	variantId: string;
	minutes: number;
	price: number;
};

export const LABOR_STEP = 15;

// "1h 15m" → 75, "2h" → 120, "45m" → 45; null for anything else.
export function variantMinutes(title: string): number | null {
	const m = /^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*$/i.exec(title);
	if (!m || (m[1] === undefined && m[2] === undefined)) return null;
	const minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
	return minutes > 0 ? minutes : null;
}

export function formatMinutes(minutes: number) {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return [h > 0 && `${h}h`, m > 0 && `${m}m`].filter(Boolean).join(" ") || "0m";
}

// The fewest variants adding up to exactly `minutes`, longest first, or
// null when they can't.
export function splitLabor(
	minutes: number,
	variants: readonly LaborVariant[],
): LaborVariant[] | null {
	if (!Number.isInteger(minutes) || minutes <= 0) return null;
	// fewest[t]: how few variants make t minutes; last[t]: the last one used.
	const fewest = [0];
	const last: (LaborVariant | null)[] = [null];
	for (let t = 1; t <= minutes; t++) {
		fewest.push(Number.POSITIVE_INFINITY);
		last.push(null);
		for (const v of variants) {
			if (v.minutes > t || fewest[t - v.minutes] + 1 >= fewest[t]) continue;
			fewest[t] = fewest[t - v.minutes] + 1;
			last[t] = v;
		}
	}
	const out: LaborVariant[] = [];
	for (let t = minutes; t > 0; ) {
		const v = last[t];
		if (!v) return null;
		out.push(v);
		t -= v.minutes;
	}
	return out.sort((a, b) => b.minutes - a.minutes);
}

// The hourly rate, read off the 1h variant (or worked out from another).
export function hourlyRate(variants: readonly LaborVariant[]) {
	const hour = variants.find((v) => v.minutes === 60) ?? variants[0];
	return hour ? Math.round((hour.price * 60 * 100) / hour.minutes) / 100 : null;
}
