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

const usdWhole = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 0,
});
const usdCompact = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	notation: "compact",
	maximumFractionDigits: 1,
});

// For glanceable totals: $543,096 rather than $543,096.04.
export function formatMoneyWhole(value: number) {
	return usdWhole.format(value);
}

// For chart labels: $86.2K.
export function formatMoneyCompact(value: number) {
	return usdCompact.format(value);
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
