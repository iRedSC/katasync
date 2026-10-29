import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { parsePeriod } from "#/orders/sales-report";
import {
	handOff,
	readArtifact,
	readRevision,
	reportPage,
	saveRevision,
} from "#/reports/store";

function periodOf(text: string) {
	const period = parsePeriod(text);
	if (!period) throw new Error(`Not a period: ${text}`);
	return period;
}

export const getReportPage = createServerFn({ method: "GET" })
	.validator(type({ period: "string" }))
	.handler(async ({ data }) => reportPage(getDb(), periodOf(data.period)));

export const saveReportRevision = createServerFn({ method: "POST" })
	.validator(type({ period: "string" }))
	.handler(async ({ data }) => saveRevision(getDb(), periodOf(data.period)));

export const getReportRevision = createServerFn({ method: "GET" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => readRevision(getDb(), data.id));

export const getReportArtifact = createServerFn({ method: "GET" })
	.validator(
		type({ snapshotId: "number.integer > 0", name: /^[a-z-]+\.(csv|html)$/ }),
	)
	.handler(async ({ data }) => readArtifact(getDb(), data));

export const handOffRevision = createServerFn({ method: "POST" })
	.validator(
		type({
			snapshotId: "number.integer > 0",
			digest: /^[0-9a-f]{64}$/,
			recipient: "0 < string <= 200",
			"note?": "string <= 1000 | null",
		}),
	)
	.handler(async ({ data }) => {
		const row = await handOff(getDb(), data);
		return { id: row.id, handedAt: row.handedAt };
	});
