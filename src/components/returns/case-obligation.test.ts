import { expect, test } from "vitest";
import { deadlineChip } from "./case-obligation";

const now = Date.parse("2026-10-25T12:00:00Z");
test.each([
	[49, undefined, false, "49h left"],
	[48, undefined, false, "48h left"],
	[47, "warning", false, "47h left"],
	[11, "critical", false, "11h left"],
	[12, "warning", false, "12h left"],
	[0.5, "critical", false, "30m left"],
	[-1, "critical", true, "1h overdue"],
	[-0.5, "critical", true, "30m overdue"],
])("deadline %sh away", (hours, tone, overdue, label) => {
	expect(deadlineChip(new Date(now + Number(hours) * 3_600_000), now)).toEqual({
		tone,
		overdue,
		label,
	});
});
