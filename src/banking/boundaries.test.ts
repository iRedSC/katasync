import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = [
	...globSync("src/banking/*.ts").filter(
		(f) => !f.endsWith(".test.ts") && !f.endsWith("test-setup.ts"),
	),
	...globSync("src/components/banking/*.{ts,tsx}"),
	"src/server/banking.ts",
	"src/routes/reconciliation.tsx",
	"src/db/banking-schema.ts",
	"drizzle/0126_banking.sql",
	"drizzle/0127_banking_evidence.sql",
];

const FORBIDDEN = [
	/\bfetch\(/,
	/https?:\/\//,
	/#\/payouts\//,
	/#\/channels\//,
	/#\/integrations\//,
	/refreshPayouts/,
	/supplier_payments|supplierPayments/,
	/process\.env/,
];

describe("banking boundaries", () => {
	it("calls no bank, payment, or marketplace API and reads no secrets", () => {
		expect(FILES.length).toBeGreaterThan(10);
		for (const file of FILES) {
			const text = readFileSync(file, "utf8");
			for (const pattern of FORBIDDEN)
				expect({ file, found: pattern.test(text) }).toEqual({
					file,
					found: false,
				});
		}
	});

	it("only ever adds payout rows' evidence, never writes payouts", () => {
		for (const file of FILES.filter((f) => f.endsWith(".ts"))) {
			const text = readFileSync(file, "utf8");
			expect({
				file,
				writes: /\.(insert|update|delete)\(payouts\)/.test(text),
			}).toEqual({ file, writes: false });
		}
		for (const file of FILES.filter((f) => f.endsWith(".sql"))) {
			expect({
				file,
				writes:
					/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?payouts"?\b/i.test(
						readFileSync(file, "utf8"),
					),
			}).toEqual({ file, writes: false });
		}
	});
});
