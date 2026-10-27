// The number each line prints with on the PO, by line id, so the page and the
// PDF name a line the same way. A draft prints every line; once sent, only
// what the supplier was sent. Lines come in the order they were added, so a
// line added after sending never moves one the supplier already has.
export function lineNumbers(
	lines: readonly { id: number; sentQuantity: number | null }[],
	sent: boolean,
): ReadonlyMap<number, number> {
	const printed = sent ? lines.filter((l) => l.sentQuantity !== null) : lines;
	return new Map(printed.map((l, i) => [l.id, i + 1]));
}
