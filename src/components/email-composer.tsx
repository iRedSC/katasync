import { Link } from "@tanstack/react-router";
import { Mail, Paperclip } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { DialogFooter } from "#/components/ui/dialog";
import { cn } from "#/lib/utils";

export type EmailPreview = {
	to: string | null;
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
// Edits change this email only; the template is in Settings.
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
	const change = (next: EmailEdit) => {
		setSubject(next.subject);
		setText(next.text);
		onDirty(next.subject !== preview.subject || next.text !== preview.text);
	};
	return (
		<>
			<div className="flex flex-col gap-3">
				<p className="text-sm text-muted-foreground">
					To <span className="text-foreground">{preview.to}</span>
				</p>
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
				{blocked ? (
					<span role="alert" className="text-sm text-warning-text sm:mr-auto">
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
