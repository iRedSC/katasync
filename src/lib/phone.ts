// Phone numbers as someone types them: US numbers take the (717) 766-0608
// shape as the digits arrive, an extension keeps its digits after "ext.",
// and anything starting with + other than +1 is left as typed, since other
// countries group digits their own way.

const EXTENSION = /\s*(?:ext\.?|extension|x|#)\s*(\d*)\s*$/i;

function usShape(digits: string) {
	if (digits.length <= 3) return digits;
	if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
	return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// The number reshaped, or as typed when it isn't a US number.
export function formatPhoneInput(raw: string): string {
	const trimmed = raw.trimStart();
	if (/^\+(?!1)/.test(trimmed)) return raw;
	// Partway through typing "ext": wait for the rest.
	if (/\s(?:e|ex|exte?n?s?i?o?)$/i.test(raw)) return raw;
	const ext = raw.match(EXTENSION);
	const main = ext ? raw.slice(0, ext.index) : raw;
	let digits = main.replace(/\D/g, "");
	// A leading 1 is the country code once there's a whole number after it.
	if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
	else if (/^\+1/.test(trimmed)) digits = digits.slice(1);
	// Too long to be one US number: leave it for the person to sort out.
	if (digits.length > 10) return raw;
	const shaped = usShape(digits);
	if (!ext) return shaped;
	return `${shaped} ext. ${ext[1]}`;
}

// Where the caret goes after reshaping: after the same number of digits it
// was after, so typing in the middle keeps its place.
export function caretAfterDigits(text: string, digits: number) {
	if (digits <= 0) {
		// Before the first digit, past any "(" it opens with.
		const first = text.search(/\d/);
		return first === -1 ? text.length : Math.min(first, text.length);
	}
	let seen = 0;
	for (let i = 0; i < text.length; i++) {
		if (/\d/.test(text[i]) && ++seen === digits) return i + 1;
	}
	return text.length;
}

export const digitsBefore = (text: string, at: number) =>
	text.slice(0, at).replace(/\D/g, "").length;

// A tel: link that dials the number, with its extension after a pause.
export function telHref(phone: string) {
	const ext = phone.match(EXTENSION);
	const main = (ext ? phone.slice(0, ext.index) : phone).replace(/[^\d+]/g, "");
	const dial = /^\+/.test(main)
		? main
		: main.length === 10
			? `+1${main}`
			: main.length === 11 && main.startsWith("1")
				? `+${main}`
				: main;
	return `tel:${dial}${ext?.[1] ? `,${ext[1]}` : ""}`;
}
