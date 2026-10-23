import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { DATE_FORMATS } from "#/banking/dates";
import { Button } from "#/components/ui/button";
import type { BankCsvMapping, BankDateFormat } from "#/db/banking-schema";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Draft } from "./import-step";

const FORMATS: BankDateFormat[] = ["ymd", "mdy", "dmy"];

const select =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring disabled:bg-subtle";

export function MappingForm({
	draft,
	busy,
	problem,
	onChange,
	onBack,
	onPreview,
}: {
	draft: Draft;
	busy: boolean;
	problem: string | null;
	onChange: (mapping: BankCsvMapping) => void;
	onBack: () => void;
	onPreview: () => void;
}) {
	const { headers, sample, rowCount } = draft.peek;
	const m = draft.mapping;
	const column = (value: string, set: (v: string) => void, label: string) => (
		<select
			value={value}
			onChange={(e) => set(e.target.value)}
			disabled={busy}
			aria-label={label}
			className={select}
		>
			{headers.map((h) => (
				<option key={h} value={h}>
					{h}
				</option>
			))}
		</select>
	);
	const optional = (
		value: string | null,
		set: (v: string | null) => void,
		label: string,
	) => (
		<select
			value={value ?? ""}
			onChange={(e) => set(e.target.value || null)}
			disabled={busy}
			aria-label={label}
			className={select}
		>
			<option value="">None</option>
			{headers.map((h) => (
				<option key={h} value={h}>
					{h}
				</option>
			))}
		</select>
	);
	const used = new Set(
		[
			m.date,
			m.description,
			...(m.amount.kind === "signed"
				? [m.amount.column]
				: [m.amount.moneyIn, m.amount.moneyOut]),
			m.bankId,
			m.currency,
		].filter((h): h is string => h !== null),
	);

	return (
		<div className="flex flex-col gap-4">
			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full text-xs">
					<thead>
						<tr className="bg-subtle text-left">
							{headers.map((h) => (
								<th
									key={h}
									className={cn(
										"px-2 py-1.5 font-medium whitespace-nowrap",
										used.has(h) && "text-primary",
									)}
								>
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{sample.map((r) => (
							<tr key={r.rowNumber} className="border-t">
								{headers.map((h, j) => (
									<td
										key={h}
										className="max-w-48 truncate px-2 py-1 text-muted-foreground"
									>
										{r.cells[j]}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="text-xs text-muted-foreground">
				{formatCount(rowCount)} rows
			</p>

			<div className="grid gap-3 sm:grid-cols-2">
				<Field label="Date">
					<div className="flex gap-2">
						{column(m.date, (date) => onChange({ ...m, date }), "Date column")}
						<select
							value={m.dateFormat}
							onChange={(e) => {
								const dateFormat = FORMATS.find((f) => f === e.target.value);
								if (dateFormat) onChange({ ...m, dateFormat });
							}}
							disabled={busy}
							aria-label="Date format"
							className={cn(select, "w-36")}
						>
							{FORMATS.map((k) => (
								<option key={k} value={k}>
									{DATE_FORMATS[k]}
								</option>
							))}
						</select>
					</div>
				</Field>
				<Field label="Description">
					{column(
						m.description,
						(description) => onChange({ ...m, description }),
						"Description column",
					)}
				</Field>
				<Field label="Amount">
					<div className="flex gap-1 rounded-lg bg-subtle p-0.5">
						{(["signed", "split"] as const).map((kind) => (
							<button
								key={kind}
								type="button"
								disabled={busy}
								onClick={() =>
									m.amount.kind !== kind &&
									onChange({
										...m,
										amount:
											kind === "signed"
												? { kind, column: headers[0], positiveMeans: "in" }
												: {
														kind,
														moneyIn: headers[0],
														moneyOut: headers[1] ?? headers[0],
													},
									})
								}
								className={cn(
									"h-7 flex-1 rounded-md text-xs",
									m.amount.kind === kind && "bg-card font-medium shadow-card",
								)}
							>
								{kind === "signed"
									? "One column, signed"
									: "Money in / money out"}
							</button>
						))}
					</div>
				</Field>
				{m.amount.kind === "signed" ? (
					<Field label="Amount column">
						<div className="flex gap-2">
							{column(
								m.amount.column,
								(c) =>
									m.amount.kind === "signed" &&
									onChange({ ...m, amount: { ...m.amount, column: c } }),
								"Amount column",
							)}
							<select
								value={m.amount.positiveMeans}
								onChange={(e) =>
									m.amount.kind === "signed" &&
									onChange({
										...m,
										amount: {
											...m.amount,
											positiveMeans: e.target.value === "out" ? "out" : "in",
										},
									})
								}
								disabled={busy}
								aria-label="What a positive amount means"
								className={cn(select, "w-40")}
							>
								<option value="in">+ is money in</option>
								<option value="out">+ is money out</option>
							</select>
						</div>
					</Field>
				) : (
					<Field label="Money in · money out">
						<div className="flex gap-2">
							{column(
								m.amount.moneyIn,
								(c) =>
									m.amount.kind === "split" &&
									onChange({ ...m, amount: { ...m.amount, moneyIn: c } }),
								"Money in column",
							)}
							{column(
								m.amount.moneyOut,
								(c) =>
									m.amount.kind === "split" &&
									onChange({ ...m, amount: { ...m.amount, moneyOut: c } }),
								"Money out column",
							)}
						</div>
					</Field>
				)}
				<Field label="Bank's transaction ID">
					{optional(
						m.bankId,
						(bankId) => onChange({ ...m, bankId }),
						"Bank ID column",
					)}
				</Field>
				<Field label="Currency">
					{optional(
						m.currency,
						(currency) => onChange({ ...m, currency }),
						"Currency column",
					)}
				</Field>
			</div>

			<div className="flex items-center gap-3">
				<Button variant="ghost" onClick={onBack} disabled={busy}>
					Another file
				</Button>
				<Button onClick={onPreview} disabled={busy}>
					{busy && <Loader2 className="animate-spin" />}
					Preview
				</Button>
				{problem && (
					<span className="text-xs text-critical-text">{problem}</span>
				)}
			</div>
		</div>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}
