import { Minus, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import { formatMinutes, LABOR_STEP } from "#/repairs/labor";
import { useDraft } from "./draft";
import type { Detail } from "./repair-data";

// Time spent on one tool, or on the order as a whole, typed in 15-minute
// steps. It goes on the draft order as Shopify's labor variants, at
// Shopify's price.

const quick = [15, 30, 60, 120];

type Labor = Detail["labor"][number];

export function LaborList({
	labor,
	rate,
	bench,
	editable,
	onAdd,
	onEdit,
	onRemove,
}: {
	labor: Labor[];
	// The hourly rate, or null when there's no price (a bench job's time).
	rate: number | null;
	bench: boolean;
	editable: boolean;
	onAdd: (minutes: number, note: string) => void;
	onEdit: (laborId: number, edit: { minutes?: number; note?: string }) => void;
	onRemove: (laborId: number) => void;
}) {
	const price = (m: number) => (rate === null ? null : (rate * m) / 60);
	return (
		<>
			<ul>
				{labor.map((l) => (
					<li
						key={l.id}
						className="flex items-center gap-3 border-t px-4 py-2 animate-in fade-in"
					>
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
							id={`labor-${l.id}`}
							value={l.note}
							disabled={!editable}
							onSave={(note) => onEdit(l.id, { note })}
						/>
						{!bench && (
							<span className="w-20 text-right tabular-nums text-muted-foreground">
								{formatMoney(price(l.minutes))}
							</span>
						)}
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
		</>
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
			className="flex flex-wrap items-center gap-2 border-t bg-surface px-4 py-2"
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

// Saves when it loses focus or Enter is pressed, if it was typed in and
// differs. Untouched, it follows the value; `id` names the record, so another
// one starts over.
export function NoteField({
	id,
	value,
	disabled,
	onSave,
	placeholder = "Note",
}: {
	id: string | number;
	value: string;
	disabled?: boolean;
	onSave: (value: string) => void;
	placeholder?: string;
}) {
	const note = useDraft(value, id);
	return (
		<input
			value={note.value}
			disabled={disabled}
			placeholder={disabled ? "" : placeholder}
			onChange={(e) => note.type(e.target.value)}
			onBlur={() => {
				const text = note.save();
				if (text !== null) onSave(text);
			}}
			onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
			className="h-8 min-w-0 flex-1 rounded-lg bg-transparent px-2 outline-none hover:bg-surface focus:bg-surface disabled:hover:bg-transparent"
		/>
	);
}
