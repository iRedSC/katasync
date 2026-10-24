import { globSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { stockChannels } from "./channels";

test("stock adapters expose observations, never a write capability", () => {
	for (const adapter of Object.values(stockChannels)) {
		expect(Object.keys(adapter).sort()).toEqual(["name", "read", "target"]);
	}
});

test("stock adapters contain no inventory mutation operation", () => {
	const files = globSync("src/stock-push/channels/*.ts");
	expect(files.length).toBeGreaterThan(3);
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		expect({
			file,
			writes:
				/inventorySetQuantities|inventoryAdjustQuantities|ReviseInventoryStatus|inventory\/update|["']PATCH["']/.test(
					source,
				),
		}).toEqual({ file, writes: false });
	}
});
