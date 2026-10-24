// A repair's number as typed or scanned: "R1001", "1001", or the ticket's
// QR code, which a scanner types as the repair's address.
export function repairNumber(text: string) {
	const m = /(?:\/repairs\/|^\s*r?)(\d{3,})\s*$/i.exec(text);
	return m ? Number(m[1]) : null;
}
