import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { shake } from "#/components/shake";
import { cn } from "#/lib/utils";

// Bottom sheet for a line's receiving note: what whoever unpacked it wants
// known. Blank saves as no note. Closing with changes unsaved asks first, so a
// stray tap on the backdrop can't lose them. Stays open until the note is
// saved, so one that doesn't save is still here to try again.
export function NoteSheet({
	title,
	note,
	onSave,
	onClose,
}: {
	title: string;
	note: string | null;
	// null takes the note off. True once the server has it.
	onSave: (note: string | null) => Promise<boolean>;
	onClose: () => void;
}) {
	const [text, setText] = useState(note ?? "");
	const ref = useRef<HTMLTextAreaElement>(null);
	const next = text.trim() || null;
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);
	const sheet = useRef<HTMLDivElement>(null);
	// While it saves, the line already shows the new note.
	const changed = next !== note || saving;

	const close = () => {
		if (saving) return shake(sheet.current);
		if (changed && !confirm("Throw away this note?")) return;
		onClose();
	};
	const save = async (value: string | null) => {
		if (saving) return;
		setSaving(true);
		setFailed(false);
		if (await onSave(value)) return onClose();
		setSaving(false);
		setFailed(true);
		shake(sheet.current);
	};
	const closeRef = useRef(close);
	closeRef.current = close;

	useEffect(() => {
		const onKey = (e: KeyboardEvent) =>
			e.key === "Escape" && closeRef.current();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Cursor at the end, so adding to a note is one tap.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, []);

	return (
		<div className="fixed inset-0 z-50 flex flex-col justify-end">
			{/* pointerdown, as in QuantitySheet: the finger that opened the
			    sheet lifts over this backdrop. */}
			<button
				type="button"
				tabIndex={-1}
				aria-label="Close"
				onPointerDown={close}
				className="absolute inset-0 bg-black/40"
			/>
			<div
				ref={sheet}
				role="dialog"
				aria-modal="true"
				aria-label={`Note for ${title}`}
				className="relative max-h-svh overflow-y-auto overscroll-contain rounded-t-3xl bg-card px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
			>
				<div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-surface-strong" />
				<p className="truncate text-center text-base font-semibold">{title}</p>
				<textarea
					ref={ref}
					value={text}
					onChange={(e) => {
						setText(e.target.value);
						setFailed(false);
					}}
					readOnly={saving}
					rows={4}
					placeholder="e.g. 2 crushed, kept"
					className={cn(
						"mt-3 w-full resize-none rounded-2xl bg-subtle p-3 text-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
						failed && "ring-2 ring-critical-border",
					)}
				/>
				<button
					type="button"
					disabled={!changed || saving}
					onClick={() => save(next)}
					className="mt-3 h-16 w-full rounded-2xl bg-primary text-xl font-bold text-white active:bg-primary-hover disabled:opacity-40"
				>
					{saving
						? "Saving…"
						: !changed
							? "No changes"
							: next === null
								? "Remove note"
								: "Save note"}
				</button>
				{note !== null && next !== null && !saving && (
					<button
						type="button"
						onClick={() => save(null)}
						className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-lg font-semibold text-muted-foreground active:bg-surface"
					>
						<Trash2 className="size-5" />
						Remove note
					</button>
				)}
			</div>
		</div>
	);
}
