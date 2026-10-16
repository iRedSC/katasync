// Whether today's suggestion wants more of a draft line than it has, in
// single items. `wants` is null when the suggestion doesn't have the product.
// Shared by Update (draftChanges) and the page, so the bar counts exactly
// what Update would raise.
export const wantsMore = (line: {
	wants: number | null;
	quantity: number;
	packSize: number;
}) => line.wants !== null && line.wants > line.quantity * line.packSize;
