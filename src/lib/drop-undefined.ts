// A server function's input arrives with its undefined keys intact: the
// client serializer keeps them. TypeScript lets a caller pass undefined for
// an optional key, but arktype treats an optional key as absent-or-the-type,
// so `{ note: undefined }` fails `"note?": "string"`. Dropping the undefined
// keys before any validator runs makes the two agree for every server
// function.
export function dropUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(dropUndefined);
	if (!isPlainObject(value)) return value;
	const kept: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value))
		if (v !== undefined) kept[key] = dropUndefined(v);
	return kept;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
