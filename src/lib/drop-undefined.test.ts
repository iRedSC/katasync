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
});
