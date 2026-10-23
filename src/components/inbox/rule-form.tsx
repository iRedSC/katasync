import {
	CircleCheck,
	Hand,
	MailOpen,
	OctagonAlert,
	Plus,
	Star,
	Trash2,
	X,
} from "lucide-react";
import { type Ref, useEffect, useState } from "react";
import { Badge } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import type { RulePreview } from "#/inbox/rule-store";
import {
	type Condition,
	describe,
	FOLDER_NAMES,
	FOLDERS,
	type Folder,
	fieldName,
	MARKET_CHOICES,
	type Match,
	marketName,
	type RuleInput,
	ruleSchema,
	TEXT_FIELDS,
} from "#/inbox/rules";
import { cn } from "#/lib/utils";
import { previewMailRule } from "#/server/inbox";
import { folderIcon } from "./folders";
import { TermsInput } from "./terms-input";

// One rule being written: its conditions, what it does, and the mail it
// matches, shown as it's written so a rule is tried before it's saved.

export type Draft = RuleInput;

// Where the draft is on its way to the server. Saving locks it; failing keeps
// it, so it can be sent again as it is.
export type SaveState = "idle" | "saving" | "failed";

const field =
	"h-9 rounded-lg border border-input bg-white px-2 outline-none focus:border-ring";

// A blank name takes the rule's first condition as its name.
export const named = (d: Draft): Draft => ({
	...d,
	name: d.name.trim() || (d.conditions[0] ? describe(d.conditions[0], 2) : ""),
});

const blank = (f: Condition["field"]): Condition =>
	f === "market"
		? { field: "market", is: [], not: false }
		: { field: f, has: [], not: false };

export function RuleForm({
	initial,
	formRef,
	save,
	unsaved,
	onChange,
	onSave,
	onCancel,
	onDelete,
}: {
	initial: Draft;
	formRef: Ref<HTMLFormElement>;
	save: SaveState;
	// Says so when leaving was blocked over unsaved edits.
	unsaved: boolean;
	onChange: (d: Draft) => void;
	onSave: (d: Draft) => void;
	onCancel: () => void;
	onDelete?: () => void;
}) {
	const [d, setD] = useState(initial);
	const set = (next: Draft) => {
		setD(next);
		onChange(next);
	};
	const setCondition = (i: number, c: Condition) =>
		set({ ...d, conditions: d.conditions.map((x, j) => (j === i ? c : x)) });
	const parsed = ruleSchema.safeParse(named(d));
	const problem = parsed.success ? null : parsed.error.issues[0]?.message;

	return (
		<form
			ref={formRef}
			onSubmit={(e) => {
				e.preventDefault();
				if (parsed.success && save !== "saving") onSave(parsed.data);
			}}
			// Locked while saving, so an edit can't land after the draft was sent.
			inert={save === "saving"}
			className={cn(
				"space-y-4 rounded-xl border bg-card p-4 shadow-card transition-opacity",
				(unsaved || save === "failed") && "border-critical-border",
				save === "saving" && "opacity-60",
			)}
		>
			<input
				aria-label="Name"
				value={d.name}
				placeholder={named({ ...d, name: "" }).name || "Name"}
				onChange={(e) => set({ ...d, name: e.target.value })}
				className={cn(field, "w-full font-semibold")}
			/>

			<section className="space-y-2">
				<h3 className="text-xs font-semibold text-muted-foreground">When</h3>
				{d.conditions.map((c, i) => (
					<ConditionRow
						// biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id; rows only append and remove
						key={i}
						condition={c}
						joiner={i === 0 ? null : d.match}
						onJoin={() =>
							set({ ...d, match: d.match === "all" ? "any" : "all" })
						}
						onChange={(next) => setCondition(i, next)}
						onRemove={
							d.conditions.length > 1
								? () =>
										set({
											...d,
											conditions: d.conditions.filter((_, j) => j !== i),
										})
								: undefined
						}
					/>
				))}
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={() =>
						set({ ...d, conditions: [...d.conditions, blank("subject")] })
					}
				>
					<Plus />
					{d.match === "any" ? "Or" : "And"}
				</Button>
			</section>

			<section className="space-y-2">
				<h3 className="text-xs font-semibold text-muted-foreground">Then</h3>
				<div className="flex flex-wrap items-center gap-1">
					<Choice
						active={d.folder === null}
						onClick={() => set({ ...d, folder: null })}
					>
						Leave the folder
					</Choice>
					{FOLDERS.map((f) => {
						const Icon = folderIcon(f);
						return (
							<Choice
								key={f}
								active={d.folder === f}
								onClick={() => set({ ...d, folder: f })}
							>
								<Icon className="size-4" />
								{FOLDER_NAMES[f]}
							</Choice>
						);
					})}
					<span className="mx-1 h-5 w-px bg-border" />
					{/* Critical is important too: unmarking important unmarks both. */}
					<Choice
						active={d.important && !d.critical}
						onClick={() =>
							set({
								...d,
								important: !(d.important && !d.critical),
								critical: false,
							})
						}
					>
						<Star
							className={cn(
								"size-4",
								d.important && "fill-warning-fill text-warning-text",
							)}
						/>
						Important
					</Choice>
					<Choice
						active={d.critical}
						onClick={() =>
							set({ ...d, important: !d.critical, critical: !d.critical })
						}
					>
						<OctagonAlert
							className={cn(
								"size-4",
								d.critical && "fill-critical-fill text-critical-icon",
							)}
						/>
						Critical
					</Choice>
					<Tip content="Not when important">
						<span>
							<Choice
								active={d.markRead}
								onClick={() => set({ ...d, markRead: !d.markRead })}
							>
								<MailOpen className="size-4" />
								Arrives read
							</Choice>
						</span>
					</Tip>
					<Choice
						active={d.markDone}
						onClick={() => set({ ...d, markDone: !d.markDone })}
					>
						<CircleCheck className="size-4" />
						Arrives done
					</Choice>
				</div>
			</section>

			<Preview rule={parsed.success ? parsed.data : null} />

			<footer className="flex items-center gap-2">
				{onDelete && (
					<Button type="button" size="sm" variant="ghost" onClick={onDelete}>
						<Trash2 />
						Delete
					</Button>
				)}
				<span
					className={cn(
						"ml-auto text-sm",
						unsaved
							? "font-medium text-critical-text"
							: "text-muted-foreground",
					)}
				>
					{unsaved
						? "Unsaved changes"
						: save === "failed"
							? "Not saved"
							: problem}
				</span>
				<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					type="submit"
					size="sm"
					disabled={!parsed.success || save === "saving"}
				>
					Save
				</Button>
			</footer>
		</form>
	);
}

function ConditionRow({
	condition: c,
	joiner,
	onJoin,
	onChange,
	onRemove,
}: {
	condition: Condition;
	// How it joins the ones before: null for the first.
	joiner: Match | null;
	// Flips every joiner between and and or.
	onJoin: () => void;
	onChange: (c: Condition) => void;
	onRemove?: () => void;
}) {
	return (
		<div className="flex flex-wrap items-start gap-1.5">
			{joiner === null ? (
				<span className="w-9" />
			) : (
				<Tip content={joiner === "all" ? "Switch to or" : "Switch to and"}>
					<button
						type="button"
						onClick={onJoin}
						className="mt-1.5 h-6 w-9 rounded-md text-right text-sm font-medium text-muted-foreground underline decoration-dotted underline-offset-4 hover:bg-surface hover:text-foreground"
					>
						<span
							key={joiner}
							className="inline-block pr-1 animate-in zoom-in-75"
						>
							{joiner === "all" ? "and" : "or"}
						</span>
					</button>
				</Tip>
			)}
			<select
				aria-label="Field"
				value={c.field}
				onChange={(e) => {
					const f = e.target.value as Condition["field"];
					// Text carries over between text fields; markets don't.
					onChange(
						f !== "market" && c.field !== "market"
							? { ...c, field: f }
							: blank(f),
					);
				}}
				className={field}
			>
				{[...TEXT_FIELDS, "market" as const].map((f) => (
					<option key={f} value={f}>
						{fieldName(f)}
					</option>
				))}
			</select>
			<select
				aria-label="Has or lacks"
				value={c.not ? "not" : "has"}
				onChange={(e) => onChange({ ...c, not: e.target.value === "not" })}
				className={field}
			>
				<option value="has">{c.field === "market" ? "is" : "has"}</option>
				<option value="not">{c.field === "market" ? "isn't" : "lacks"}</option>
			</select>
			{c.field === "market" ? (
				<div className="flex flex-1 flex-wrap gap-1 pt-0.5">
					{MARKET_CHOICES.map((m) => (
						<Choice
							key={m}
							active={c.is.includes(m)}
							onClick={() =>
								onChange({
									...c,
									is: c.is.includes(m)
										? c.is.filter((x) => x !== m)
										: [...c.is, m],
								})
							}
						>
							{m === "other" ? "No marketplace" : marketName(m)}
						</Choice>
					))}
				</div>
			) : (
				<TermsInput
					terms={c.has}
					onChange={(has) => onChange({ ...c, has })}
					placeholder={
						c.field === "sender"
							? "amazon.com, seller-notification@…"
							: "refund*, return request"
					}
				/>
			)}
			{onRemove && (
				<Button
					type="button"
					size="sm"
					variant="ghost"
					aria-label="Remove condition"
					onClick={onRemove}
					className="mt-0.5"
				>
					<X />
				</Button>
			)}
		</div>
	);
}

function Choice({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition-colors",
				active
					? "border-primary bg-surface-strong text-foreground"
					: "border-transparent text-muted-foreground hover:bg-surface hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

// The mail the rule matches, refreshed a moment after each edit.
function Preview({ rule }: { rule: Draft | null }) {
	const [shown, setShown] = useState<RulePreview | null>(null);
	// The name changes nothing matched, so editing it doesn't ask again.
	const key = rule ? JSON.stringify({ ...rule, name: "preview" }) : null;
	useEffect(() => {
		if (!key) return;
		let current = true;
		const timer = setTimeout(async () => {
			const r = await previewMailRule({ data: JSON.parse(key) }).catch(
				() => null,
			);
			if (current) setShown(r);
		}, 300);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [key]);
	if (!key || !shown) return null;
	return (
		<section className="space-y-1.5 rounded-lg bg-subtle p-3">
			<p key={shown.count} className="text-sm font-medium animate-in fade-in-0">
				Matches {shown.count} {shown.count === 1 ? "email" : "emails"}
			</p>
			<ul className="space-y-1">
				{shown.emails.map((e) => (
					<li key={e.id} className="flex items-center gap-2 text-sm">
						<span className="w-36 shrink-0 truncate text-muted-foreground">
							{e.from}
						</span>
						<span className="min-w-0 flex-1 truncate">{e.subject}</span>
						{e.critical ? (
							<OctagonAlert className="size-3.5 shrink-0 fill-critical-fill text-critical-icon" />
						) : (
							e.important && (
								<Star className="size-3.5 shrink-0 fill-warning-fill text-warning-text" />
							)
						)}
						{e.pinned && (
							<Hand
								aria-label="Moved by hand; stays put"
								className="size-3.5 shrink-0 text-muted-foreground"
							/>
						)}
						<Badge>{FOLDER_NAMES[e.folder as Folder]}</Badge>
					</li>
				))}
			</ul>
		</section>
	);
}
