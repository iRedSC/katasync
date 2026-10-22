import { useRef, useState } from "react";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import {
	DEFAULT_TEMPLATES,
	PLACEHOLDERS,
	TEMPLATE_KINDS,
	TEMPLATE_NAMES,
	type Template,
	type TemplateKind,
	templateProblems,
} from "#/purchasing/email-templates";
import {
	type EmailTemplateRow,
	resetEmailTemplate,
	saveEmailTemplate,
} from "#/server/email-templates";

export const templatesData = optimistic<EmailTemplateRow[]>("email-templates");

const field =
	"w-full rounded-lg border border-input bg-white px-2.5 outline-none focus:border-ring";

const same = (a: Template, b: Template) =>
	a.subject === b.subject && a.body === b.body;

// The wording of the emails sent to suppliers. Placeholders fill in per
// email; the damage list and attachments are laid out by katasync. Each email
// can still be edited before it's sent.
export function EmailTemplatesCard({
	templates,
}: {
	templates: EmailTemplateRow[];
}) {
	const [kind, setKind] = useState<TemplateKind>("purchase_order");
	// Edits per email, kept while switching between them.
	const [drafts, setDrafts] = useState<Partial<Record<TemplateKind, Template>>>(
		{},
	);
	const body = useRef<HTMLTextAreaElement>(null);
	const subject = useRef<HTMLInputElement>(null);
	const lastField = useRef<"subject" | "body">("body");

	const saved = templates.find((t) => t.kind === kind) ?? {
		kind,
		...DEFAULT_TEMPLATES[kind],
		custom: false,
	};
	const draft = drafts[kind] ?? saved;
	const edited = !same(draft, saved);
	const problems = templateProblems(kind, draft);
	const set = (t: Template) => setDrafts((d) => ({ ...d, [kind]: t }));
	const drop = (k: TemplateKind) =>
		setDrafts((d) => ({ ...d, [k]: undefined }));
	// Clears a draft once the save or reset that sent it is acknowledged, but
	// only that revision: one typed while it was in flight stays.
	const settle = (k: TemplateKind, sent: Template | undefined) =>
		setDrafts((d) => (d[k] === sent ? { ...d, [k]: undefined } : d));

	const unsaved = (k: TemplateKind) => {
		const d = drafts[k];
		const t = templates.find((x) => x.kind === k) ?? DEFAULT_TEMPLATES[k];
		return d !== undefined && !same(d, t);
	};

	const patchRow = (t: Template, custom: boolean) =>
		templatesData.patch("all", (rows) =>
			rows.map((r) => (r.kind === kind ? { ...r, ...t, custom } : r)),
		);

	async function save(t: Template, custom = true) {
		const r = await optimism.change({
			label: `${TEMPLATE_NAMES[kind]} email`,
			patch: patchRow(t, custom),
			send: () => saveEmailTemplate({ data: { kind, ...t } }),
		});
		if (r) settle(kind, t);
		return r;
	}

	async function reset() {
		const was = { subject: saved.subject, body: saved.body };
		const typed = drafts[kind];
		const r = await optimism.change({
			label: `${TEMPLATE_NAMES[kind]} email`,
			patch: patchRow(DEFAULT_TEMPLATES[kind], false),
			send: () => resetEmailTemplate({ data: { kind } }),
		});
		if (!r) return;
		settle(kind, typed);
		offerUndo(`${TEMPLATE_NAMES[kind]} email back to the default wording`, {
			undo: async () => ((await save(was)) ? "Your wording is back" : null),
		});
	}

	// Puts a placeholder where the cursor was, in the field last used.
	function insert(name: string) {
		const token = `{${name}}`;
		const into = lastField.current;
		const el = into === "subject" ? subject.current : body.current;
		const value = into === "subject" ? draft.subject : draft.body;
		const start = el?.selectionStart ?? value.length;
		const end = el?.selectionEnd ?? value.length;
		const next = value.slice(0, start) + token + value.slice(end);
		set(
			into === "subject"
				? { ...draft, subject: next }
				: { ...draft, body: next },
		);
		requestAnimationFrame(() => {
			el?.focus();
			el?.setSelectionRange(start + token.length, start + token.length);
		});
	}

	return (
		<section id="email-templates" className="scroll-mt-4">
			<Card
				title="Email templates"
				aside={
					<div className="flex rounded-lg bg-subtle p-0.5 text-sm font-semibold">
						{TEMPLATE_KINDS.map((k) => (
							<button
								key={k}
								type="button"
								aria-pressed={k === kind}
								onClick={() => setKind(k)}
								className={cn(
									"rounded-md px-2.5 py-1",
									k === kind
										? "bg-white shadow-card"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{TEMPLATE_NAMES[k]}
								{unsaved(k) && (
									<span className="ml-1 text-warning-text">•</span>
								)}
							</button>
						))}
					</div>
				}
			>
				<div className="flex flex-col gap-3">
					<input
						ref={subject}
						aria-label="Subject"
						value={draft.subject}
						onFocus={() => {
							lastField.current = "subject";
						}}
						onChange={(e) => set({ ...draft, subject: e.target.value })}
						className={cn(field, "h-9 font-medium")}
					/>
					<textarea
						ref={body}
						aria-label="Message"
						value={draft.body}
						rows={12}
						onFocus={() => {
							lastField.current = "body";
						}}
						onChange={(e) => set({ ...draft, body: e.target.value })}
						className={cn(
							field,
							"resize-y py-2 font-mono text-xs leading-relaxed",
							problems.length > 0 && "border-critical-border",
						)}
					/>
					<div className="flex flex-wrap gap-1.5">
						{Object.entries(PLACEHOLDERS[kind]).map(([name, about]) => (
							<Tip key={name} content={about}>
								<button
									type="button"
									onClick={() => insert(name)}
									className="rounded-md border px-1.5 py-0.5 font-mono text-xs hover:bg-muted"
								>
									{`{${name}}`}
								</button>
							</Tip>
						))}
					</div>
					{problems.length > 0 && (
						<ul role="alert" className="text-sm text-critical-text">
							{problems.map((p) => (
								<li key={p}>{p}</li>
							))}
						</ul>
					)}
					<div className="flex items-center justify-end gap-2">
						{saved.custom && !edited && (
							<Button
								size="sm"
								variant="ghost"
								className="mr-auto text-muted-foreground"
								onClick={reset}
							>
								Use default wording
							</Button>
						)}
						{edited && (
							<Button size="sm" variant="ghost" onClick={() => drop(kind)}>
								Discard
							</Button>
						)}
						<Button
							size="sm"
							disabled={!edited || problems.length > 0}
							onClick={() => save(draft)}
						>
							Save
						</Button>
					</div>
				</div>
			</Card>
		</section>
	);
}
