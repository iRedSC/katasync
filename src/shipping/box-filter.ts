// Finding a box by what's written on it: its size, as on the label, or its
// name. Shared by quick ship, settings, and invoices, so it runs in the
// browser too.

const MM_PER_INCH = 25.4;

export type BoxSize = { lengthMm: number; widthMm: number; heightMm: number };
export type NamedBox = BoxSize & { name: string | null };

export const inches = (mm: number) => Math.round((mm / MM_PER_INCH) * 10) / 10;
const sides = (b: BoxSize) => [b.lengthMm, b.widthMm, b.heightMm].map(inches);

// "12 × 9 × 4"
export const boxSize = (b: BoxSize) => sides(b).join(" × ");

// "Mailer 12 × 9 × 4", or just the size when it has no name.
export const boxLabel = (b: NamedBox) =>
	b.name ? `${b.name} ${boxSize(b)}` : boxSize(b);

// What was typed: numbers are sides in order, words are bits of the name.
// "12x9", "12 9" and "12, 9" all mean length 12, width 9.
export function parseBoxQuery(query: string) {
	const numbers: string[] = [];
	const words: string[] = [];
	for (const token of query.toLowerCase().split(/[\s×*,]+/)) {
		if (token === "") continue;
		if (/^[\d.]+(x[\d.]*)*$/.test(token))
			numbers.push(...token.split("x").filter((n) => n !== ""));
		else words.push(token);
	}
	return { numbers, words };
}

// The size typed, when it's all three sides and nothing else.
export function typedSize(query: string): BoxSize | null {
	const { numbers, words } = parseBoxQuery(query);
	const n = numbers.map(Number);
	if (words.length > 0 || n.length !== 3 || !n.every((x) => x > 0)) return null;
	const [lengthMm, widthMm, heightMm] = n.map((x) =>
		Math.round(x * MM_PER_INCH),
	);
	return { lengthMm, widthMm, heightMm };
}

export const sameSize = (a: BoxSize, b: BoxSize) =>
	sides(a).join() === sides(b).join();

// The boxes that fit what's typed, a box of exactly the typed size first.
// Each number starts the side in its place ("1" finds 12 and 14 long);
// each word is somewhere in the name. Nothing typed finds every box.
export function filterBoxes<B extends NamedBox>(boxes: B[], query: string) {
	const { numbers, words } = parseBoxQuery(query);
	const found = boxes.filter((b) => {
		const own = sides(b).map(String);
		const name = (b.name ?? "").toLowerCase();
		return (
			numbers.length <= 3 &&
			numbers.every((n, i) => own[i] === n || own[i].startsWith(n)) &&
			words.every((w) => name.includes(w))
		);
	});
	const size = typedSize(query);
	if (!size) return found;
	return [
		...found.filter((b) => sameSize(b, size)),
		...found.filter((b) => !sameSize(b, size)),
	];
}
