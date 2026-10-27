import type { movementReason } from "#/db/schema";

// The shop's zone, which every date is shown in. The server and the browser
// must print the same text for the same instant, so neither uses its own.
export const SHOP_TIME_ZONE = "America/New_York";

const usd = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});
const count = new Intl.NumberFormat("en-US");
const dateTime = new Intl.DateTimeFormat("en-US", {
	dateStyle: "medium",
	timeStyle: "short",
	timeZone: SHOP_TIME_ZONE,
});
const dateOnly = new Intl.DateTimeFormat("en-US", {
	dateStyle: "medium",
	timeZone: SHOP_TIME_ZONE,
});
const dateOnlyUtc = new Intl.DateTimeFormat("en-US", {
	dateStyle: "medium",
	timeZone: "UTC",
});

export function formatMoney(value: number | null) {
	return value === null ? "—" : usd.format(value);
}

export function formatCount(value: number) {
	return count.format(value);
}

export function formatDateTime(value: Date | string) {
	return dateTime.format(new Date(value));
}

// A calendar day as Postgres `date` columns and date inputs give it. It names
// a day, not an instant: read as UTC midnight and shown in the shop's zone it
// would land on the day before, so the date formatters show it as written.
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

// The instant to format and the zone to format it in. A calendar day is
// formatted at UTC midnight in UTC, which is that day everywhere.
function dayToShow(value: Date | string) {
	return typeof value === "string" && CALENDAR_DAY.test(value)
		? { date: new Date(`${value}T00:00:00Z`), utc: true }
		: { date: new Date(value), utc: false };
}

// "Oct 20, 2026", for dates that may be from another year.
export function formatDate(value: Date | string) {
	const { date, utc } = dayToShow(value);
	return (utc ? dateOnlyUtc : dateOnly).format(date);
}

export function formatDelta(delta: number) {
	return delta > 0 ? `+${count.format(delta)}` : count.format(delta);
}

// Every reason needs a label, so a new one can't show up raw.
const reasonLabels: Record<(typeof movementReason.enumValues)[number], string> =
	{
		receipt: "Received",
		sale: "Sale",
		return: "Return",
		adjustment: "Correction",
		transfer_out: "Transfer out",
		transfer_in: "Transfer in",
		assembly_consume: "Used in assembly",
		assembly_produce: "Assembled",
		opening_balance: "Opening balance",
		oversold_reset: "Oversold written off",
	};

export function formatReason(reason: string) {
	return reasonLabels[reason as keyof typeof reasonLabels] ?? reason;
}

const time = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
	timeZone: SHOP_TIME_ZONE,
});
const monthDay = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: SHOP_TIME_ZONE,
});
const monthDayUtc = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});
// The shop's calendar day as "2026-10-21", so days can be counted apart.
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TIME_ZONE });
const DAY_MS = 24 * 60 * 60 * 1000;
// Which shop day an instant falls on, as a count of days from the epoch. Whole
// calendar days, so a 23- or 25-hour day doesn't throw the count off.
const dayNumber = (d: Date) =>
	Date.parse(`${dayKey.format(d)}T00:00:00Z`) / DAY_MS;

// Like Shopify's order list: "Today at 2:08 PM", "Yesterday at…", "Oct 4 at…".
// `today` is the clock the words count from. Null gives the date alone, for a
// render with no clock to agree on (the server, and the browser until it has
// hydrated).
export function formatOrderDate(
	value: Date | string,
	today: Date | null = new Date(),
) {
	const date = new Date(value);
	const daysAgo = today === null ? null : dayNumber(today) - dayNumber(date);
	const day =
		daysAgo === 0
			? "Today"
			: daysAgo === 1
				? "Yesterday"
				: monthDay.format(date);
	return `${day} at ${time.format(date)}`;
}

// "2:08 PM".
export function formatTime(value: Date | string) {
	return time.format(new Date(value));
}

// "Oct 20", for dates where the time doesn't matter.
export function formatDay(value: Date | string) {
	const { date, utc } = dayToShow(value);
	return (utc ? monthDayUtc : monthDay).format(date);
}

// "Mechanicsburg, PA 17055", leaving out whatever is missing.
export function cityLine(
	city: string | null,
	region: string | null,
	zip: string | null,
) {
	const place = [region, zip].filter(Boolean).join(" ");
	return [city, place].filter(Boolean).join(", ");
}

// US numbers as (717) 766-0608; anything else as given.
export function formatPhone(phone: string) {
	const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
	return digits.length === 10
		? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
		: phone;
}

// What a person calls each channel. A store's own name is its account name
// (Shopify's is the company), so lists say the channel instead.
export const channelNames: Record<string, string> = {
	shopify: "Shopify",
	amazon: "Amazon",
	ebay: "eBay",
	tiktok: "TikTok Shop",
};

export function channelName(channel: string) {
	return channelNames[channel] ?? channel;
}

// How a PO line is ordered in. packSize is how many of the product one unit
// holds; supplierCount is the count the supplier puts on it, which the PO
// prints. They differ when the supplier's "PACK of 5" is one of our product.
export type OrderUnit = {
	unit: string;
	packSize: number;
	supplierCount: number;
};

// The unit as the supplier calls it and the PO prints it: "EACH", or
// "CASE of 30" when they count several in one.
export function supplierUnit(t: { unit: string; supplierCount: number }) {
	return t.supplierCount === 1
		? t.unit
		: `${t.unit} of ${formatCount(t.supplierCount)}`;
}

// The unit for us: supplierUnit, plus what it adds to stock when that isn't
// the supplier's count, so "PACK of 5" never reads as five of ours.
export function formatUnit(t: OrderUnit) {
	return t.supplierCount === t.packSize
		? supplierUnit(t)
		: `${supplierUnit(t)} (counts as ${formatCount(t.packSize)})`;
}

// "12", or "2 CASE of 30" when the supplier sells in packs, or
// "2 PACK of 5 (counts as 2)" when their count isn't ours.
export function formatOrderQuantity(q: OrderUnit & { quantity: number }) {
	if (q.unit === "EACH") return formatCount(q.quantity);
	const ordered = `${formatCount(q.quantity)} ${supplierUnit(q)}`;
	return q.supplierCount === q.packSize
		? ordered
		: `${ordered} (counts as ${formatCount(q.quantity * q.packSize)})`;
}
