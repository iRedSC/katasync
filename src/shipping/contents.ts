// One key for "what's in this box": every SKU and quantity in the order,
// merged and sorted, e.g. "HANDLE×1|KNIFE-5×2". Two orders with the same
// contents ship the same way, so quick ship reuses the last box and weight.
// Lines without a SKU (custom items) count by their title.
export function contentsKey(
	lines: { sku: string | null; title: string; quantity: number }[],
): string {
	const totals = new Map<string, number>();
	for (const line of lines) {
		const key = (line.sku ?? line.title).trim().toUpperCase();
		totals.set(key, (totals.get(key) ?? 0) + line.quantity);
	}
	return [...totals]
		.filter(([, quantity]) => quantity > 0)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([sku, quantity]) => `${sku}×${quantity}`)
		.join("|");
}
