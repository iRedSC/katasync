import { labelPath } from "#/shipping/label-path";

// Prints a dispatch's labels, one per box. For now that opens the first
// label's PDF: browsers allow one new tab per key press, so quick ship and
// the order page link the rest. QZ Tray printing (in progress) replaces
// this with one print job holding every label.
export function printLabels(shipmentIds: number[]) {
	const [first] = shipmentIds;
	if (first !== undefined) window.open(labelPath(first), "_blank");
}
