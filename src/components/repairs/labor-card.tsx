import { Minus, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import { formatMinutes, hourlyRate, LABOR_STEP } from "#/repairs/labor";
import type { Detail } from "./repair-data";

// Time spent on the tool, typed in 15-minute steps. It all goes on the
// draft order as Shopify's labor variants, at Shopify's price.

const quick = [15, 30, 60, 120];

export function LaborCard({
	d,
	editable,
	onAdd,
	onEdit,
	onRemove,
}: {
	d: Detail;
	editable: boolean;
	onAdd: (minutes: number, note: string) => void;
	onEdit: (laborId: number, edit: { minutes?: number; note?: string }) => void;
	onRemove: (laborId: number) => void;
}) {
	const rate = d.laborVariants ? hourlyRate(d.laborVariants) : null;
	const total = d.labor.reduce((n, l) => n + l.minutes, 0);
	const price = (m: number) => (rate === null ? null : (rate * m) / 60);
	return (
		<Card
			title="Labor"
			flush
			aside={
				total > 0 && (
					<span className="tabular-nums">
						{formatMinutes(total)}
						{rate !== null && `, ${formatMoney(price(total))}`}
					</span>
				)
			}
		>
			<ul>
				{d.labor.map((l) => (
					<li key={l.id} className="flex items-center gap-3 border-t px-4 py-2">
						{editable ? (
							<Stepper
								value={l.minutes}
								onChange={(minutes) => onEdit(l.id, { minutes })}
							/>
						) : (
							<span className="w-28 font-semibold tabular-nums">
								{formatMinutes(l.minutes)}
							</span>
						)}
						<NoteField
							value={l.note}
							disabled={!editable}
							onSave={(note) => onEdit(l.id, { note })}
						/>
						<span className="w-20 text-right tabular-nums text-muted-foreground">
							{formatMoney(price(l.minutes))}
						</span>
						{editable && (
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Take off"
								onClick={() => onRemove(l.id)}
							>
								<Trash2 />
							</Button>
						)}
					</li>
				))}
			</ul>
			{editable && <AddLabor onAdd={onAdd} rate={rate} />}
			{!d.laborVariants && (
				<p className="border-t px-4 py-2 text-warning-text">
					Couldn't read the labor product from Shopify
				</p>
			)}
		</Card>
	);
}

function AddLabor({
	onAdd,
	rate,
}: {
	onAdd: (minutes: number, note: string) => void;
	rate: number | null;
}) {
	const [minutes, setMinutes] = useState(0);
	const [note, setNote] = useState("");
	const add = () => {
		if (minutes === 0) return;
		onAdd(minutes, note);
		setMinutes(0);
		setNote("");
	};
	return (
		<form
			className="flex flex-wrap items-center gap-2 border-t bg-surface px-4 py-3"
			onSubmit={(e) => {
				e.preventDefault();
				add();
			}}
		>
			{quick.map((m) => (
				<button
					key={m}
					type="button"
					onClick={() => setMinutes((x) => x + m)}
					className="h-8 rounded-full bg-card px-3 font-semibold shadow-card hover:bg-subtle"
				>
					+{formatMinutes(m)}
				</button>
			))}
			<Stepper value={minutes} onChange={setMinutes} min={0} />
			<input
				value={note}
				onChange={(e) => setNote(e.target.value)}
				placeholder="What was done"
				className="h-8 min-w-40 flex-1 rounded-lg border border-input bg-white px-2 outline-none focus:border-ring"
			/>
			<Button type="submit" disabled={minutes === 0}>
				Add
				{minutes > 0 &&
					rate !== null &&
					` ${formatMoney((rate * minutes) / 60)}`}
			</Button>
		</form>
	);
}

function Stepper({
	value,
	onChange,
	min = LABOR_STEP,
}: {
	value: number;
	onChange: (minutes: number) => void;
	min?: number;
}) {
	return (
		<span className="flex w-28 items-center justify-between">
			<button
				type="button"
				aria-label="Less time"
				disabled={value - LABOR_STEP < min}
				onClick={() => onChange(value - LABOR_STEP)}
				className="rounded-md p-1 hover:bg-surface-strong disabled:opacity-30"
			>
				<Minus className="size-4" />
			</button>
			<span
				className={cn(
					"font-semibold tabular-nums",
					value === 0 && "text-muted-foreground",
				)}
			>
				{formatMinutes(value)}
			</span>
			<button
				type="button"
				aria-label="More time"
				onClick={() => onChange(value + LABOR_STEP)}
				className="rounded-md p-1 hover:bg-surface-strong"
			>
				<Plus className="size-4" />
			</button>
		</span>
	);
}

// Saves when it loses focus or Enter is pressed, if it changed.
export function NoteField({
	value,
	disabled,
	onSave,
	placeholder = "Note",
}: {
	value: string;
	disabled?: boolean;
	onSave: (value: string) => void;
	placeholder?: string;
}) {
	const [text, setText] = useState(value);
	return (
		<input
			value={text}
			disabled={disabled}
			placeholder={disabled ? "" : placeholder}
			onChange={(e) => setText(e.target.value)}
			onBlur={() => text !== value && onSave(text)}
			onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
			className="h-8 min-w-0 flex-1 rounded-lg bg-transparent px-2 outline-none hover:bg-surface focus:bg-surface disabled:hover:bg-transparent"
		/>
	);
}
