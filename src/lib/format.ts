const usd = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});
const count = new Intl.NumberFormat("en-US");
const dateTime = new Intl.DateTimeFormat("en-US", {
	dateStyle: "medium",
	timeStyle: "short",
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

export function formatDelta(delta: number) {
	return delta > 0 ? `+${count.format(delta)}` : count.format(delta);
}

const reasonLabels: Record<string, string> = {
	receipt: "Received",
	sale: "Sale",
	return: "Return",
	adjustment: "Correction",
	transfer_out: "Transfer out",
	transfer_in: "Transfer in",
	assembly_consume: "Used in assembly",
	assembly_produce: "Assembled",
	opening_balance: "Opening balance",
};

export function formatReason(reason: string) {
	return reasonLabels[reason] ?? reason;
}

const time = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
});
const monthDay = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
});

// Like Shopify's order list: "Today at 2:08 PM", "Yesterday at…", "Oct 4 at…".
export function formatOrderDate(value: Date | string) {
	const date = new Date(value);
	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
	const day = same(date, today)
		? "Today"
		: same(date, yesterday)
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
	return monthDay.format(new Date(value));
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

// What a PO line is ordered in: "EACH", or "CASE of 30" when one unit holds
// several of the product.
export function formatUnit(unit: string, packSize: number) {
	return packSize === 1 ? unit : `${unit} of ${formatCount(packSize)}`;
}

// "12", or "2 CASE of 30" when the supplier sells in packs.
export function formatOrderQuantity(q: {
	quantity: number;
	unit: string;
	packSize: number;
}) {
	return q.unit === "EACH"
		? formatCount(q.quantity)
		: `${formatCount(q.quantity)} ${formatUnit(q.unit, q.packSize)}`;
}
