// A server function's input arrives with its undefined keys intact: the
// client serializer keeps them. TypeScript lets a caller pass undefined for
// an optional key, but arktype treats an optional key as absent-or-the-type,
// so `{ note: undefined }` fails `"note?": "string"`. Dropping the undefined
// keys before any validator runs makes the two agree for every server
// function.
export function dropUndefined(value: unknown): unknown {
	// The serializer keeps shared and cyclic references, so each object is
	// copied once and every reference to it gets that copy.
	const copies = new WeakMap<object, unknown>();
	const visit = (v: unknown): unknown => {
		if (!Array.isArray(v) && !isPlainObject(v)) return v;
		const seen = copies.get(v);
		if (seen) return seen;
		if (Array.isArray(v)) {
			const copy: unknown[] = [];
			copies.set(v, copy);
			for (const item of v) copy.push(visit(item));
			return copy;
		}
		const copy: Record<string, unknown> = {};
		copies.set(v, copy);
		for (const [key, item] of Object.entries(v))
			if (item !== undefined)
				// Defined, not assigned: an own `__proto__` key stays a key
				// instead of swapping the copy's prototype.
				Object.defineProperty(copy, key, {
					value: visit(item),
					enumerable: true,
					writable: true,
					configurable: true,
				});
		return copy;
	};
	return visit(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
