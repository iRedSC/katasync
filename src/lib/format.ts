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
	adjustment: "Adjustment",
	transfer_out: "Transfer out",
	transfer_in: "Transfer in",
	assembly_consume: "Used in assembly",
	assembly_produce: "Assembled",
	opening_balance: "Opening balance",
};

export function formatReason(reason: string) {
	return reasonLabels[reason] ?? reason;
}
