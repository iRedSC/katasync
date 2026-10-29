import { type } from "arktype";
import { describe, expect, test } from "vitest";
import { dropUndefined } from "./drop-undefined";

describe("dropUndefined", () => {
	test("lets an optional key passed as undefined through arktype", () => {
		const input = type({ orderId: "number", "note?": "string" });
		const sent = { orderId: 1, note: undefined };
		expect(input(sent)).toBeInstanceOf(type.errors);
		expect(input(dropUndefined(sent))).toEqual({ orderId: 1 });
	});

	test("reaches keys nested in objects and arrays", () => {
		expect(
			dropUndefined({
				lines: [{ id: 1, note: undefined }],
				a: { b: undefined },
			}),
		).toEqual({ lines: [{ id: 1 }], a: {} });
	});

	test("keeps null, and leaves non-plain objects whole", () => {
		const when = new Date(0);
		const out = dropUndefined({ note: null, when }) as Record<string, unknown>;
		expect(out).toEqual({ note: null, when });
		expect(out.when).toBe(when);
		expect(dropUndefined(undefined)).toBeUndefined();
	});

	test("copies a shared object once and survives cycles", () => {
		let shared: Record<string, unknown> = { x: 1, gone: undefined };
		for (let i = 0; i < 40; i++) shared = { a: shared, b: shared };
		const out = dropUndefined(shared) as { a: unknown; b: unknown };
		expect(out.a).toBe(out.b);

		const loop: Record<string, unknown> = { gone: undefined };
		loop.self = loop;
		const copy = dropUndefined(loop) as Record<string, unknown>;
		expect(copy.self).toBe(copy);
		expect("gone" in copy).toBe(false);
	});

	test("keeps an own __proto__ key as a key", () => {
		const input = JSON.parse('{"__proto__": {"new": 1}, "id": "c"}');
		const out = dropUndefined(input) as Record<string, unknown>;
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect("new" in out).toBe(false);
		expect(Object.hasOwn(out, "__proto__")).toBe(true);
	});
});
