// Days as date inputs and the server take them, YYYY-MM-DD.

import { SHOP_TIME_ZONE } from "#/lib/format";

// Today at the shop, not in UTC.
export const today = () =>
	new Date().toLocaleDateString("en-CA", { timeZone: SHOP_TIME_ZONE });

// The day something happened in UTC, as the server dates a PO.
export const utcDay = (at: Date | string) =>
	new Date(at).toISOString().slice(0, 10);

// Midday, so the date doesn't slip a day in any US timezone.
export const middayOf = (day: string) => new Date(`${day}T12:00:00`);
