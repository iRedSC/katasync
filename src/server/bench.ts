import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { getDb } from "#/db/client";
import { repairs } from "#/db/repair-schema";
import { refurbishOptions } from "#/orders/refurbish";
import { listBench, RepairError, startBench } from "#/repairs/bench";

// Bench jobs (src/repairs/bench.ts): putting a returned unit or a tool
// bought in on the bench, and listing it as a refurb when it's done.

const jobFields = {
	"tool?": "string <= 200",
	"serial?": "string <= 100 | null",
	"problem?": "string <= 2000",
	"technicianId?": "number.integer > 0 | null",
} as const;

export const startBenchJob = createServerFn({ method: "POST" })
	.validator(
		type({
			orderId: "number.integer > 0",
			lineId: "number.integer > 0",
			quantity: "1 <= number.integer <= 20",
			...jobFields,
		}).or({ productId: "number.integer > 0", ...jobFields }),
	)
	.handler(async ({ data }) => ({ ids: await startBench(getDb(), data) }));

// What the job's refurb starts as, from its product.
export const getBenchListing = createServerFn({ method: "GET" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [r] = await db
			.select({ productId: repairs.productId })
			.from(repairs)
			.where(eq(repairs.id, data.id));
		if (!r?.productId) throw new RepairError(`R${data.id} isn't a bench job`);
		return refurbishOptions(db, { productId: r.productId });
	});

const details = {
	condition: "string > 0",
	title: "string > 0",
	price: "number > 0",
	compareAtPrice: "number > 0 | null",
	weightGrams: "number.integer > 0 | null",
	vendor: "string",
	productType: "string",
	tags: "string[]",
	notes: "string",
} as const;

export const listBenchJob = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			as: type({ kind: "'new'", ...details }).or({
				kind: "'add'",
				productId: "number.integer > 0",
			}),
		}),
	)
	.handler(({ data }) => listBench(getDb(), data.id, data.as));
