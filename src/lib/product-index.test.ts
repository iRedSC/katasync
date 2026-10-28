import { describe, expect, it, vi } from "vitest";
import { type IndexedProduct, indexState } from "./product-index";

const products = [{ id: 1, sku: "A" }] as IndexedProduct[];

describe("indexState", () => {
	it("is loading until there's a list or a failure", () => {
		expect(
			indexState({
				data: undefined,
				error: null,
				isFetching: true,
				refetch: vi.fn(),
			}),
		).toEqual({ status: "loading" });
	});

	it("is ready with the list", () => {
		expect(
			indexState({
				data: products,
				error: null,
				isFetching: false,
				refetch: vi.fn(),
			}),
		).toEqual({ status: "ready", products });
	});

	it("keeps the last list when a refresh fails", () => {
		expect(
			indexState({
				data: products,
				error: new Error("down"),
				isFetching: false,
				refetch: vi.fn(),
			}),
		).toEqual({ status: "ready", products });
	});

	it("fails with a retry that loads again", () => {
		const refetch = vi.fn();
		const state = indexState({
			data: undefined,
			error: new Error("down"),
			isFetching: false,
			refetch,
		});
		if (state.status !== "failed") throw new Error("expected failed");
		expect(state.message).toBe("down");
		state.retry();
		expect(refetch).toHaveBeenCalledOnce();
	});

	it("is loading again while a retry runs", () => {
		expect(
			indexState({
				data: undefined,
				error: new Error("down"),
				isFetching: true,
				refetch: vi.fn(),
			}).status,
		).toBe("loading");
	});
});
