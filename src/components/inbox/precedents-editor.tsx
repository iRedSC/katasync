import { useRouter } from "@tanstack/react-router";
import { Bot, Plus, RotateCcw, Scale, ScrollText, Trash2 } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import type { Precedent } from "#/buyers/precedents";
import { Badge, EmptyState } from "#/components/page";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import {
	deletePrecedentFn,
	type PrecedentsPage,
	restorePrecedentFn,
	saveBasePrompt,
	savePrecedentFn,
} from "#/server/buyer-drafts";

// What the reply agent follows, laid out like the Rules page: the base
// prompt it starts from, pinned first, then each precedent (when this, then
// that). One opens at a time to edit; another won't open over unsaved
// edits, which shake and say so.

const store = optimistic<Precedent[]>("reply-precedents");

type Open = "base" | "new" | number | null;
type SaveState = "idle" | "saving" | "failed";

export function PrecedentsEditor({ page }: { page: PrecedentsPage }) {
	const router = useRouter();
	const precedents = store.useData("all", page.precedents);
	const [editing, setEditing] = useState<Open>(null);
	const [dirty, setDirty] = useState(false);
	const [blocked, setBlocked] = useState(false);
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const form = useRef<HTMLFormElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when another opens
	useEffect(() => {
		form.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [editing]);

	const close = () => {
		setEditing(null);
		setDirty(false);
		setBlocked(false);
		setSaveState("idle");
	};
	const open = (next: Open) => {
		if (saveState === "saving") return;
		if (dirty && next !== editing) {
			setBlocked(true);
			shake(form.current);
			return;
		}
		close();
		setEditing(next);
	};

	// Stays open, locked, until the server has it; a rejection leaves the
	// edit to retry.
	async function save(send: () => Promise<unknown>, label: string) {
		setSaveState("saving");
		const r = await optimism.change({ label, patch: [], send });
		if (!r) {
			setSaveState("failed");
			return;
		}
		close();
		await router.invalidate();
	}

	async function remove(p: Precedent) {
		close();
		const r = await optimism.change({
			label: "Deleting the precedent",
			patch: store.patch("all", (list) => list.filter((x) => x.id !== p.id)),
			send: () => deletePrecedentFn({ data: { id: p.id } }),
		});
		if (!r) return;
		offerUndo("Deleted", {
			undo: async () => {
				const back = await optimism.change({
					label: "Putting it back",
					patch: [],
					send: () => restorePrecedentFn({ data: p }),
				});
				await router.invalidate();
				return back ? "Put back" : null;
			},
		});
	}

	async function resetBase() {
		const before = page.base.prompt;
		close();
		const r = await optimism.change({
			label: "Putting the default back",
			patch: [],
			send: () => saveBasePrompt({ data: { prompt: null } }),
		});
		if (!r) return;
		await router.invalidate();
		offerUndo("Default prompt back", {
			undo: async () => {
				await saveBasePrompt({ data: { prompt: before } });
				await router.invalidate();
				return "Your prompt is back";
			},
		});
	}

	const shared = {
		formRef: form,
		save: saveState,
		unsaved: blocked,
		onChange: () => {
			setDirty(true);
			setSaveState("idle");
		},
		onCancel: close,
	};

	return (
		<div className="space-y-2 p-4 md:min-h-0 md:flex-1 md:overflow-y-auto">
			<header className="flex items-center gap-2 pb-2">
				<p className="flex-1 text-sm text-muted-foreground">
					Drafts start from the base prompt, then follow each precedent that
					fits the buyer's case.
				</p>
				<Button size="sm" variant="secondary" onClick={() => open("new")}>
					<Plus />
					New precedent
				</Button>
			</header>

			{editing === "base" ? (
				<BaseForm
					key="base"
					{...shared}
					initial={page.base.prompt}
					isDefault={page.base.isDefault}
					onSave={(prompt) =>
						save(
							() => saveBasePrompt({ data: { prompt } }),
							"Saving the base prompt",
						)
					}
					onReset={resetBase}
				/>
			) : (
				<Row
					onOpen={() => open("base")}
					icon={<ScrollText className="size-4 text-muted-foreground" />}
					title="Base prompt"
					detail={page.base.prompt}
					chips={
						page.base.isDefault ? (
							<Badge>Default</Badge>
						) : (
							page.base.by === "claude" && <ClaudeBadge />
						)
					}
				/>
			)}

			{editing === "new" && (
				<PrecedentForm
					key="new"
					{...shared}
					initial={{ name: "", when: "", action: "" }}
					onSave={(p) =>
						save(
							() => savePrecedentFn({ data: { id: null, precedent: p } }),
							"Saving the precedent",
						)
					}
				/>
			)}

			{precedents.length === 0 && editing !== "new" && (
				<EmptyState icon={Scale} title="No precedents yet" />
			)}
			<ol className="space-y-2">
				{precedents.map((p) =>
					editing === p.id ? (
						<li key={p.id}>
							<PrecedentForm
								{...shared}
								initial={p}
								onSave={(next) =>
									save(
										() =>
											savePrecedentFn({ data: { id: p.id, precedent: next } }),
										"Saving the precedent",
									)
								}
								onDelete={() => remove(p)}
							/>
						</li>
					) : (
						<li key={p.id}>
							<Row
								onOpen={() => open(p.id)}
								icon={<Scale className="size-4 text-muted-foreground" />}
								title={p.name}
								detail={`When ${p.when} · ${p.action}`}
								chips={p.by === "claude" && <ClaudeBadge />}
							/>
						</li>
					),
				)}
			</ol>
		</div>
	);
}

function ClaudeBadge() {
	return (
		<Badge tone="info">
			<Bot className="mr-1 size-3" />
			Claude
		</Badge>
	);
}

// One closed entry: what it is in a line, the rest truncated beneath.
function Row({
	onOpen,
	icon,
	title,
	detail,
	chips,
}: {
	onOpen: () => void;
	icon: ReactNode;
	title: string;
	detail: string;
	chips?: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onOpen}
			className="flex w-full min-w-0 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left hover:border-ring"
		>
			<span className="shrink-0">{icon}</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-2 font-semibold">
					<span className="truncate">{title}</span>
					{chips}
				</span>
				<span className="block truncate text-sm text-muted-foreground">
					{detail}
				</span>
			</span>
		</button>
	);
}

type FormProps = {
	formRef: Ref<HTMLFormElement>;
	save: SaveState;
	unsaved: boolean;
	onChange: () => void;
	onCancel: () => void;
};

const field =
	"w-full resize-y rounded-lg border border-input bg-white px-2.5 py-2 outline-none focus:border-ring";

// The card an entry opens into, as a rule's does.
function Frame({
	formRef,
	save,
	unsaved,
	onCancel,
	canSave,
	problem,
	onSubmit,
	left,
	children,
}: Omit<FormProps, "onChange"> & {
	canSave: boolean;
	problem: string | null;
	onSubmit: () => void;
	left?: ReactNode;
	children: ReactNode;
}) {
	return (
		<form
			ref={formRef}
			onSubmit={(e) => {
				e.preventDefault();
				if (canSave && save !== "saving") onSubmit();
			}}
			inert={save === "saving"}
			className={cn(
				"space-y-4 rounded-xl border bg-card p-4 shadow-card transition-opacity",
				(unsaved || save === "failed") && "border-critical-border",
				save === "saving" && "opacity-60",
			)}
		>
			{children}
			<footer className="flex items-center gap-2">
				{left}
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
					disabled={!canSave || save === "saving"}
				>
					Save
				</Button>
			</footer>
		</form>
	);
}

function Section({ label, children }: { label: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the field is its child
		<label className="block space-y-2">
			<span className="block text-xs font-semibold text-muted-foreground">
				{label}
			</span>
			{children}
		</label>
	);
}

function PrecedentForm({
	initial,
	onSave,
	onDelete,
	onChange,
	...frame
}: FormProps & {
	initial: { name: string; when: string; action: string };
	onSave: (p: { name: string; when: string; action: string }) => void;
	onDelete?: () => void;
}) {
	const [name, setName] = useState(initial.name);
	const [when, setWhen] = useState(initial.when);
	const [action, setAction] = useState(initial.action);
	const short = !name.trim()
		? "Name it"
		: when.trim().length < 3
			? "Say when it applies"
			: action.trim().length < 3
				? "Say what to do"
				: null;
	return (
		<Frame
			{...frame}
			canSave={short === null}
			problem={short}
			onSubmit={() => onSave({ name, when, action })}
			left={
				onDelete && (
					<Button type="button" size="sm" variant="ghost" onClick={onDelete}>
						<Trash2 />
						Delete
					</Button>
				)
			}
		>
			<input
				aria-label="Name"
				ref={(el) => {
					// A new one starts here.
					if (el && !initial.name && document.activeElement === document.body)
						el.focus();
				}}
				value={name}
				maxLength={60}
				placeholder="Name, e.g. Empty box"
				onChange={(e) => {
					setName(e.target.value);
					onChange();
				}}
				className={cn(field, "h-9 py-0 font-semibold")}
			/>
			<Section label="When">
				<textarea
					value={when}
					rows={2}
					onChange={(e) => {
						setWhen(e.target.value);
						onChange();
					}}
					placeholder="The buyer says the box arrived empty"
					className={field}
				/>
			</Section>
			<Section label="Then">
				<textarea
					value={action}
					rows={Math.max(3, action.split("\n").length)}
					onChange={(e) => {
						setAction(e.target.value);
						onChange();
					}}
					placeholder="Apologise, ship another today, no return needed"
					className={field}
				/>
			</Section>
		</Frame>
	);
}

function BaseForm({
	initial,
	isDefault,
	onSave,
	onReset,
	onChange,
	...frame
}: FormProps & {
	initial: string;
	isDefault: boolean;
	onSave: (prompt: string) => void;
	onReset: () => void;
}) {
	const [prompt, setPrompt] = useState(initial);
	const short = prompt.trim().length < 20 ? "Too short to guide it" : null;
	return (
		<Frame
			{...frame}
			canSave={short === null}
			problem={short}
			onSubmit={() => onSave(prompt)}
			left={
				!isDefault && (
					<Button type="button" size="sm" variant="ghost" onClick={onReset}>
						<RotateCcw />
						Use the default
					</Button>
				)
			}
		>
			<Section label="Base prompt">
				<textarea
					value={prompt}
					rows={Math.max(8, prompt.split("\n").length + 1)}
					onChange={(e) => {
						setPrompt(e.target.value);
						onChange();
					}}
					className={cn(field, "text-sm leading-relaxed")}
				/>
			</Section>
		</Frame>
	);
}
