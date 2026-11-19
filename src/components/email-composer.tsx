import { Link } from "@tanstack/react-router";
import { Mail, Paperclip } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { DialogFooter } from "#/components/ui/dialog";
import { Tip } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";
import type { SupplierContact } from "#/purchasing/contacts";

export type EmailPreview = {
	// Everyone it goes to, all in To.
	to: readonly SupplierContact[];
	subject: string;
	text: string;
	attachments: string[];
};

export type EmailEdit = { subject: string; text: string };

const field =
	"w-full rounded-lg border border-input bg-white px-2.5 outline-none focus:border-ring";

// Keeps a dialog open over edits that would be lost: a click outside shakes
// it and says why instead. Cancel and Esc still close it.
export function useCloseGuard() {
	const [dirty, setDirty] = useState(false);
	const [blocked, setBlocked] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const contentProps: Pick<ComponentProps<"div">, "ref"> & {
		onInteractOutside: (e: Event) => void;
	} = {
		ref,
		onInteractOutside: (e) => {
			if (!dirty) return;
			e.preventDefault();
			setBlocked(true);
			if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
				ref.current?.animate(
					[0, -6, 6, -4, 4, 0].map((x) => ({
						transform: `translateX(${x}px)`,
					})),
					{ duration: 300 },
				);
		},
	};
	return {
		blocked,
		contentProps,
		setDirty: (d: boolean) => {
			setDirty(d);
			if (!d) setBlocked(false);
		},
	};
}

// The email as it will go, from its template, for a last read and edit.
// Edits change this email only; the template is in Settings. Settings would
// unmount these edits, so the link to it is out of reach until they're sent
// or discarded.
export function EmailComposer({
	preview,
	sending,
	blocked,
	onDirty,
	onSend,
	onCancel,
	cancelLabel = "Cancel",
}: {
	preview: EmailPreview;
	sending: boolean;
	blocked: boolean;
	onDirty: (dirty: boolean) => void;
	onSend: (edit: EmailEdit) => void;
	onCancel: () => void;
	cancelLabel?: string;
}) {
	const [subject, setSubject] = useState(preview.subject);
	const [text, setText] = useState(preview.text);
	const emptySubject = !subject.trim();
	const emptyText = !text.trim();
	const edited = (e: EmailEdit) =>
		e.subject !== preview.subject || e.text !== preview.text;
	const dirty = edited({ subject, text });
	const change = (next: EmailEdit) => {
		setSubject(next.subject);
		setText(next.text);
		onDirty(edited(next));
	};
	return (
		<>
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
					To
					{preview.to.map((c) => (
						<Tip key={c.email} content={c.name && c.email}>
							<span className="rounded-full bg-muted px-2 py-0.5 text-foreground">
								{c.name ?? c.email}
							</span>
						</Tip>
					))}
				</div>
				<input
					aria-label="Subject"
					value={subject}
					disabled={sending}
					onChange={(e) => change({ subject: e.target.value, text })}
					className={cn(
						field,
						"h-9 font-medium",
						emptySubject && "border-critical-border",
					)}
				/>
				<textarea
					aria-label="Message"
					value={text}
					disabled={sending}
					rows={14}
					onChange={(e) => change({ subject, text: e.target.value })}
					className={cn(
						field,
						"resize-y py-2 text-sm leading-relaxed",
						emptyText && "border-critical-border",
					)}
				/>
				{preview.attachments.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						{preview.attachments.map((name) => (
							<span
								key={name}
								className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground"
							>
								<Paperclip className="size-3" />
								{name}
							</span>
						))}
					</div>
				)}
			</div>
			<DialogFooter className="items-center gap-2">
				{dirty ? (
					<span
						role="alert"
						className={cn(
							"text-sm text-warning-text sm:mr-auto",
							blocked && "font-medium",
						)}
					>
						Unsaved edits. Send, or {cancelLabel} to discard.
					</span>
				) : (
					<Link
						to="/settings"
						hash="email-templates"
						className="text-sm text-link hover:underline sm:mr-auto"
					>
						Edit template
					</Link>
				)}
				<Button variant="outline" disabled={sending} onClick={onCancel}>
					{cancelLabel}
				</Button>
				<Button
					disabled={sending || emptySubject || emptyText}
					onClick={() => onSend({ subject, text })}
				>
					<Mail />
					{sending ? "Sending…" : "Send"}
				</Button>
			</DialogFooter>
		</>
	);
}
