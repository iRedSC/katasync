import { type Period, periodText, shiftPeriod } from "#/orders/sales-report";

// A calendar month on a marketplace's own clock. Amazon, eBay and TikTok close
// their US statements on Pacific time; Shopify reports in the shop's zone.
export type MonthWindow = {
	period: Period;
	timeZone: string;
	start: Date;
	end: Date;
	// "2026-10-01" and "2026-10-31", the month's first and last days.
	firstDay: string;
	lastDay: string;
	json: { start: string; end: string; timeZone: string };
};

export const PACIFIC = "America/Los_Angeles";

// The UTC offset, in minutes, of a zone at an instant.
function offsetMinutes(at: Date, timeZone: string) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		})
			.formatToParts(at)
			.map((p) => [p.type, Number(p.value)]),
	);
	const asUtc = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
	);
	return (asUtc - at.getTime()) / 60_000;
}

// The instant a month starts in a zone: its first day's midnight there.
export function zonedMonthStart(p: Period, timeZone: string) {
	const naive = Date.UTC(p.year, p.month - 1, 1);
	// Twice, since the offset at the guess may differ from the offset at the
	// answer when a clock change falls between them.
	let at = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60_000);
	at = new Date(naive - offsetMinutes(at, timeZone) * 60_000);
	return at;
}

export function monthWindow(p: Period, timeZone: string): MonthWindow {
	const start = zonedMonthStart(p, timeZone);
	const end = zonedMonthStart(shiftPeriod(p, 1), timeZone);
	const lastDay = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
	const text = periodText(p);
	return {
		period: p,
		timeZone,
		start,
		end,
		firstDay: `${text}-01`,
		lastDay: `${text}-${String(lastDay).padStart(2, "0")}`,
		json: { start: start.toISOString(), end: end.toISOString(), timeZone },
	};
}
