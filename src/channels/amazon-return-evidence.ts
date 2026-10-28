import type {
	EvidenceRead,
	Money,
	ReturnLabel,
	SafetClaim,
} from "#/orders/return-evidence";

// What Amazon's returns report says about a return besides where it stands
// (amazon-returns.ts reads the rest). An older or renamed column is named
// once, rather than failing the whole report, and what it would have said
// is left unread: the saved evidence keeps it.
export const EVIDENCE_COLUMNS = [
	"A-to-Z Claim",
	"SafeT Action reason",
	"SafeT claim id",
	"SafeT claim state",
	"SafeT claim creation time",
	"SafeT claim reimbursement amount",
	"Refunded Amount",
	"Resolution",
	"In policy",
	"Return type",
	"Label type",
	"Label cost",
	"Currency code",
	"Label to be paid by",
] as const;
type EvidenceColumn = (typeof EVIDENCE_COLUMNS)[number];

// Return types we know. Another is kept as Amazon wrote it and named, so a
// new kind of return gets looked at.
const KNOWN_RETURN_TYPES: ReadonlySet<string> = new Set(["C-Returns"]);

type Row = Record<string, string>;
// Undefined where the report has no such column; "" where it left it blank.
type Cells = Record<EvidenceColumn, string | undefined>;

// Each evidence column's name as this report spells it (Amazon's casing
// drifts), and the ones it lacks.
export function evidenceColumns(header: readonly string[]) {
	const byLower = new Map(header.map((c) => [c.toLowerCase(), c]));
	const names = new Map<EvidenceColumn, string>();
	const missing: EvidenceColumn[] = [];
	for (const column of EVIDENCE_COLUMNS) {
		const found = byLower.get(column.toLowerCase());
		if (found) names.set(column, found);
		else missing.push(column);
	}
	const cells = (row: Row): Cells =>
		Object.fromEntries(
			EVIDENCE_COLUMNS.map((c) => {
				const name = names.get(c);
				return [c, name === undefined ? undefined : (row[name] ?? "")];
			}),
		) as Cells;
	return { cells, missing };
}

// Problems name the return they're on, as its importer names it.
type Problems = { of: string; list: string[] };

function yesNo(value: string, what: string, problems: Problems) {
	const v = value.trim().toLowerCase();
	if (v === "") return null;
	if (v === "y" || v === "yes" || v === "true") return true;
	if (v === "n" || v === "no" || v === "false") return false;
	problems.list.push(`${problems.of} has ${what} "${value}"`);
	return null;
}

function money(
	amount: string,
	currency: string,
	what: string,
	problems: Problems,
): Money | null {
	if (amount === "") return null;
	if (!/^-?\d+(\.\d+)?$/.test(amount)) {
		problems.list.push(`${problems.of} has ${what} "${amount}"`);
		return null;
	}
	if (currency === "") {
		problems.list.push(`${problems.of} has ${what} ${amount} with no currency`);
		return null;
	}
	return { amount, currency };
}

function time(value: string, what: string, problems: Problems) {
	if (value === "") return null;
	const at = new Date(value);
	if (Number.isNaN(at.getTime())) {
		problems.list.push(`${problems.of} has ${what} "${value}"`);
		return null;
	}
	return at;
}

// Items' amounts added up, only when every item states one in one currency:
// a missing one would make the total look smaller than it is.
export function totalOf(items: (Money | null)[]): Money | null {
	if (items.length === 0 || items.some((m) => m === null)) return null;
	const all = items as Money[];
	const currency = all[0].currency;
	if (all.some((m) => m.currency !== currency)) return null;
	if (all.length === 1) return all[0];
	const places = Math.max(
		...all.map((m) => m.amount.split(".")[1]?.length ?? 0),
	);
	const scale = 10 ** places;
	const sum = all.reduce((s, m) => s + Math.round(Number(m.amount) * scale), 0);
	return { amount: (sum / scale).toFixed(places), currency };
}

// The refund a row states, left out with the evidence it can't read.
type RowEvidence = EvidenceRead & { refunded?: Money | null };

// One item's row as evidence, with the refund it states. Each field is read
// only from a report with every column it's made of: one made of fewer would
// say less than Amazon does, and overwrite what was saved.
export function rowEvidence(
	c: Cells,
	deliveryDate: string,
	problems: Problems,
): RowEvidence {
	const has = (...columns: EvidenceColumn[]) =>
		columns.every((column) => c[column] !== undefined);
	const cell = (column: EvidenceColumn) => c[column] ?? "";
	const currency = cell("Currency code");
	const read: RowEvidence = {
		deliveredAt: time(deliveryDate, "a delivery date of", problems),
	};
	if (
		has(
			"SafeT claim id",
			"SafeT claim state",
			"SafeT Action reason",
			"SafeT claim reimbursement amount",
			"SafeT claim creation time",
			"Currency code",
		)
	) {
		const claimId = cell("SafeT claim id");
		const claim: SafetClaim | null = claimId
			? {
					id: claimId,
					state: cell("SafeT claim state") || null,
					reason: cell("SafeT Action reason") || null,
					reimbursement: money(
						cell("SafeT claim reimbursement amount"),
						currency,
						"a SAFE-T reimbursement of",
						problems,
					),
					createdAt:
						time(
							cell("SafeT claim creation time"),
							"a SAFE-T claim time",
							problems,
						)?.toISOString() ?? null,
				}
			: null;
		read.safetClaim = claim;
	}
	if (has("Label type", "Label cost", "Currency code", "Label to be paid by")) {
		const label: ReturnLabel = {
			type: cell("Label type") || null,
			cost: money(cell("Label cost"), currency, "a label cost of", problems),
			paidBy: cell("Label to be paid by") || null,
		};
		read.label = label.type || label.cost || label.paidBy ? label : null;
	}
	if (has("Return type")) {
		const returnType = cell("Return type") || null;
		if (returnType && !KNOWN_RETURN_TYPES.has(returnType))
			problems.list.push(`Unknown Amazon return type: ${returnType}`);
		read.returnType = returnType;
	}
	if (has("A-to-Z Claim"))
		read.aToZClaim = yesNo(
			cell("A-to-Z Claim"),
			"an A-to-z claim of",
			problems,
		);
	if (has("Resolution")) read.resolution = cell("Resolution") || null;
	if (has("In policy"))
		read.inPolicy = yesNo(cell("In policy"), "an in-policy of", problems);
	if (has("Refunded Amount", "Currency code"))
		read.refunded = money(
			cell("Refunded Amount"),
			currency,
			"a refunded amount of",
			problems,
		);
	return read;
}

// An RMA's items as one request's evidence. Any item under an A-to-z claim
// puts the request under it; any out of policy makes it out of policy.
// Items share the report's columns, so a field one couldn't read none could.
export function requestEvidence(items: RowEvidence[]): RowEvidence {
	const unread = (pick: (e: RowEvidence) => unknown) =>
		items.length === 0 || items.some((e) => pick(e) === undefined);
	const first = <T>(pick: (e: RowEvidence) => T | null | undefined) =>
		unread(pick)
			? undefined
			: (items.map(pick).find((v) => v !== null) ?? null);
	const flags = (
		pick: (e: RowEvidence) => boolean | null | undefined,
		wins: boolean,
	) => {
		if (unread(pick)) return undefined;
		const values = items.map(pick);
		if (values.includes(wins)) return wins;
		return values.includes(!wins) ? !wins : null;
	};
	return {
		aToZClaim: flags((e) => e.aToZClaim, true),
		safetClaim: first((e) => e.safetClaim),
		resolution: first((e) => e.resolution),
		inPolicy: flags((e) => e.inPolicy, false),
		returnType: first((e) => e.returnType),
		label: first((e) => e.label),
		deliveredAt: first((e) => e.deliveredAt),
		refunded: unread((e) => e.refunded)
			? undefined
			: totalOf(items.map((e) => e.refunded ?? null)),
	};
}
