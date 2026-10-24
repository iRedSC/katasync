import { channelName } from "#/lib/format";
import { placeName, taxName } from "#/lib/places";
import { HOW_SUFFIX, sourceName } from "./files";
import type { ReportData } from "./snapshot";

type Leaf = string | number | boolean | null;

export type Change = {
	section: string;
	row: string;
	field: string;
	before: Leaf | undefined;
	after: Leaf | undefined;
};

type Keyed = { key: string; label: string; value: unknown };

function flatten(value: unknown, path: string, out: Map<string, Leaf>) {
	if (value !== null && typeof value === "object") {
		for (const [k, v] of Object.entries(value))
			flatten(v, path ? `${path}.${k}` : k, out);
		return;
	}
	out.set(path, value as Leaf);
}

const SECTIONS: {
	name: string;
	rows: (d: ReportData) => Keyed[];
}[] = [
	{
		name: "Sales",
		rows: (d) =>
			d.channels.map((r) => ({
				key: r.source,
				label: sourceName(r.source),
				value: { ...r, source: undefined },
			})),
	},
	{
		name: "Sales tax",
		rows: (d) =>
			d.jurisdictions.map((r) => ({
				key: `${r.country}|${r.jurisdiction}|${r.rate}`,
				label: taxName(r),
				value: r,
			})),
	},
	{
		name: "By state",
		rows: (d) =>
			d.states.map((r) => ({
				key: `${r.country}|${r.state}|${r.how}`,
				label: `${placeName(r)}${HOW_SUFFIX[r.how]}`,
				value: r,
			})),
	},
	{
		name: "Deposits",
		rows: (d) =>
			d.deposits.map((r) => ({
				key: JSON.stringify([r.channel, r.externalId]),
				label: `${channelName(r.channel)} ${r.depositedAt.slice(0, 10)}`,
				value: r,
			})),
	},
	{
		name: "Contribution",
		rows: (d) => [
			{ key: "all", label: "Shipped orders", value: d.contribution },
		],
	},
	{
		name: "Evidence",
		rows: (d) =>
			d.evidence.map((r) => ({
				key: r.soldOn,
				label: channelName(r.soldOn),
				value: r,
			})),
	},
	{
		name: "Report",
		rows: (d) => [
			{
				key: "meta",
				label: "Report",
				value: {
					business: d.business,
					partial: d.partial,
					payoutErrors: d.payoutErrors,
					schemaVersion: d.schemaVersion,
					window: d.window,
				},
			},
		],
	},
];

export function reportChanges(before: ReportData, after: ReportData): Change[] {
	const changes: Change[] = [];
	for (const s of SECTIONS) {
		const a = new Map(s.rows(before).map((r) => [r.key, r]));
		const b = new Map(s.rows(after).map((r) => [r.key, r]));
		for (const key of new Set([...a.keys(), ...b.keys()])) {
			const was = new Map<string, Leaf>();
			const now = new Map<string, Leaf>();
			const ra = a.get(key);
			const rb = b.get(key);
			if (ra) flatten(ra.value, "", was);
			if (rb) flatten(rb.value, "", now);
			for (const field of new Set([...was.keys(), ...now.keys()])) {
				const x = was.get(field);
				const y = now.get(field);
				if (x === y) continue;
				changes.push({
					section: s.name,
					row: (rb ?? ra)?.label ?? key,
					field,
					before: x,
					after: y,
				});
			}
		}
	}
	return changes;
}
