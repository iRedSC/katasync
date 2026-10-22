import { useNavigate } from "@tanstack/react-router";
import {
	ArrowDown,
	ArrowUp,
	Bot,
	MailOpen,
	OctagonAlert,
	Plus,
	Star,
	Wand2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge, EmptyState } from "#/components/page";
import { Button } from "#/components/ui/button";
import type { Resorted } from "#/inbox/rule-store";
import {
	describeAll,
	FALLBACK_FOLDER,
	FOLDER_NAMES,
	type Folder,
	type Rule,
} from "#/inbox/rules";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import {
	deleteMailRule,
	reorderMailRules,
	restoreMailRule,
	saveMailRule,
} from "#/server/inbox";
import { folderIcon } from "./folders";
import { type Draft, RuleForm, type SaveState } from "./rule-form";

// The rules that sort the marketplaces mailbox, in the order they run. The
// first rule that moves an email decides its folder; every rule that marks
// it makes it important. Saving sorts the mailbox again at once.

const store = optimistic<Rule[]>("mail-rules");

// What sorting again did, in a few words.
const resorted = (r: Resorted) =>
	[
		r.moved && `${r.moved} moved`,
		r.marked && `${r.marked} marked or unmarked important`,
	]
		.filter(Boolean)
		.join(", ") || "No email moved";

export function RulesEditor({
	rules: loaded,
	open,
	draft,
}: {
	rules: Rule[];
	open: number | null;
	// A new rule started from an email: its sender, to its folder.
	draft: { sender: string; folder: Folder | null } | null;
}) {
	const rules = store.useData("all", loaded);
	const navigate = useNavigate();
	const [editing, setEditing] = useState<number | "new" | null>(
		draft ? "new" : open,
	);
	const [dirty, setDirty] = useState(false);
	const [blocked, setBlocked] = useState(false);
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const form = useRef<HTMLFormElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when another rule opens
	useEffect(() => {
		form.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [editing]);

	// Opens another rule unless the one open has unsaved edits: then it
	// shakes and says so.
	const openRule = (next: number | "new" | null) => {
		// A rule on its way to the server stays open until it lands.
		if (saveState === "saving") return;
		if (dirty && next !== editing) {
			setBlocked(true);
			if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
				form.current?.animate(
					[0, -6, 6, -4, 4, 0].map((x) => ({
						transform: `translateX(${x}px)`,
					})),
					{ duration: 300 },
				);
			return;
		}
		close();
		setEditing(next);
	};
	const close = () => {
		setEditing(null);
		setDirty(false);
		setBlocked(false);
		setSaveState("idle");
		// The link that opened it has done its job.
		if (open !== null || draft)
			void navigate({
				to: "/inbox",
				search: { folder: "rules" },
				replace: true,
			});
	};

	// The form stays open, locked, until the server has the rule. A rejection
	// leaves the draft in place to retry, and counts as unsaved.
	async function save(id: number | null, rule: Draft) {
		setDirty(true);
		setSaveState("saving");
		const r = await optimism.change({
			label: "Saving the rule",
			// Unpatched: the rule shows once the list reloads, so the form isn't
			// doubled by a row for it while the save is out.
			patch: [],
			send: () => saveMailRule({ data: { id, rule } }),
		});
		if (!r) {
			setSaveState("failed");
			return;
		}
		close();
		toast.success(`Saved: ${resorted(r.value)}`);
	}

	async function remove(rule: Rule) {
		close();
		const r = await optimism.change({
			label: `Deleting ${rule.name}`,
			patch: store.patch("all", (list) => list.filter((x) => x.id !== rule.id)),
			send: () => deleteMailRule({ data: { id: rule.id } }),
		});
		if (!r) return;
		offerUndo(`Deleted: ${resorted(r.value)}`, {
			undo: async () => {
				const { id: _, position: __, by, ...input } = rule;
				const back = await optimism.change({
					label: "Putting the rule back",
					patch: [],
					send: () =>
						restoreMailRule({
							data: { rule: input, before: r.value.before, by },
						}),
				});
				return back ? `${rule.name} is back` : null;
			},
		});
	}

	async function shift(index: number, by: -1 | 1) {
		const ids = rules.map((r) => r.id);
		[ids[index], ids[index + by]] = [ids[index + by], ids[index]];
		const r = await optimism.change({
			label: "Reordering",
			patch: store.patch("all", (list) =>
				ids.map((id) => list.find((x) => x.id === id)).filter((x) => !!x),
			),
			send: () => reorderMailRules({ data: { ids } }),
		});
		if (r && (r.value.moved || r.value.marked)) toast(resorted(r.value));
	}

	const formFor = (rule: Rule | null, initial: Draft) => (
		<RuleForm
			key={rule?.id ?? "new"}
			formRef={form}
			initial={initial}
			save={saveState}
			unsaved={blocked}
			onChange={() => {
				setDirty(true);
				setSaveState("idle");
			}}
			onSave={(d) => save(rule?.id ?? null, d)}
			onCancel={close}
			onDelete={rule ? () => remove(rule) : undefined}
		/>
	);

	return (
		<div className="space-y-2 p-4 md:min-h-0 md:flex-1 md:overflow-y-auto">
			<header className="flex items-center gap-2 pb-2">
				<p className="flex-1 text-sm text-muted-foreground">
					The first rule to move an email picks its folder; the rest go to{" "}
					{FOLDER_NAMES[FALLBACK_FOLDER]}.
				</p>
				<Button size="sm" variant="secondary" onClick={() => openRule("new")}>
					<Plus />
					New rule
				</Button>
			</header>
			{editing === "new" &&
				formFor(null, {
					name: "",
					conditions: [
						draft
							? {
									field: "sender",
									has: [draft.sender.toLowerCase()],
									not: false,
								}
							: { field: "subject", has: [], not: false },
					],
					folder: draft?.folder ?? null,
					important: false,
					critical: false,
					markRead: false,
					match: "all",
				})}
			{rules.length === 0 && editing !== "new" && (
				<EmptyState icon={Wand2} title="No rules: everything goes to Updates" />
			)}
			<ol className="space-y-2">
				{rules.map((r, i) =>
					editing === r.id ? (
						<li key={r.id}>{formFor(r, r)}</li>
					) : (
						<li key={r.id} className="group flex items-center gap-1">
							<button
								type="button"
								onClick={() => openRule(r.id)}
								className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left hover:border-ring"
							>
								<span className="w-5 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
									{i + 1}
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex items-center gap-2 font-semibold">
										<span className="truncate">{r.name}</span>
										{r.by === "claude" && (
											<Badge tone="info">
												<Bot className="mr-1 size-3" />
												Claude
											</Badge>
										)}
									</span>
									<span className="block truncate text-sm text-muted-foreground">
										{describeAll(r)}
									</span>
								</span>
								<Effects rule={r} />
							</button>
							<span className="flex flex-col opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
								<Button
									size="sm"
									variant="ghost"
									aria-label="Run earlier"
									disabled={i === 0}
									onClick={() => shift(i, -1)}
									className="h-6"
								>
									<ArrowUp />
								</Button>
								<Button
									size="sm"
									variant="ghost"
									aria-label="Run later"
									disabled={i === rules.length - 1}
									onClick={() => shift(i, 1)}
									className="h-6"
								>
									<ArrowDown />
								</Button>
							</span>
						</li>
					),
				)}
			</ol>
		</div>
	);
}

// What a rule does, as chips: its folder, and a star when it marks important
// (a red octagon when critical).
function Effects({ rule: r }: { rule: Rule }) {
	const Icon = r.folder ? folderIcon(r.folder) : null;
	return (
		<span className="flex shrink-0 items-center gap-1.5">
			{r.folder && Icon && (
				<span className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-strong px-2 text-xs font-medium">
					<Icon className="size-3.5" />
					{FOLDER_NAMES[r.folder]}
				</span>
			)}
			{r.critical ? (
				<OctagonAlert
					aria-label="Marks critical"
					className="size-4 fill-critical-fill text-critical-icon"
				/>
			) : (
				r.important && (
					<Star
						aria-label="Marks important"
						className="size-4 fill-warning-fill text-warning-text"
					/>
				)
			)}
			{r.markRead && (
				<MailOpen
					aria-label="Arrives read"
					className="size-4 text-muted-foreground"
				/>
			)}
		</span>
	);
}
