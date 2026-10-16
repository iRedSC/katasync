import { type ExternalToast, toast } from "sonner";

// Every Undo in the app goes through offerUndo: it shows the toast with its
// Undo button and makes Ctrl+Z (⌘Z on a Mac) do the same thing for as long as
// the toast is up. Only the newest toast's undo is armed, it runs at most
// once however it's triggered, and its failure is shown, so a caller can't
// offer an undo that silently does nothing.

type Undo = {
	toastId: string | number;
	// Says what was undone, shown once it is.
	run: () => Promise<string>;
	used: boolean;
};

let armed: Undo | null = null;

export function offerUndo(
	message: string,
	options: Omit<ExternalToast, "action" | "onDismiss" | "onAutoClose"> & {
		undo: Undo["run"];
		tone?: "success" | "warning";
	},
) {
	const { undo: run, tone, ...rest } = options;
	const entry: Undo = { toastId: "", run, used: false };
	const disarm = () => {
		if (armed === entry) armed = null;
	};
	const show = tone ? toast[tone] : toast;
	entry.toastId = show(message, {
		duration: 10_000,
		...rest,
		action: { label: "Undo", onClick: () => runUndo(entry) },
		onDismiss: disarm,
		onAutoClose: disarm,
	});
	armed = entry;
}

async function runUndo(entry: Undo) {
	if (entry.used) return;
	entry.used = true;
	if (armed === entry) armed = null;
	toast.dismiss(entry.toastId);
	try {
		toast(await entry.run());
	} catch (err) {
		toast.error(err instanceof Error ? err.message : String(err));
	}
}

function isTyping(target: EventTarget | null) {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
	);
}

// Fields keep their own Ctrl+Z for the text in them. Swapped rather than
// added on hot reload, so one press never runs twice.
function onKeyDown(e: KeyboardEvent) {
	if (e.key.toLowerCase() !== "z" || e.shiftKey || e.altKey) return;
	if (!(e.ctrlKey || e.metaKey) || isTyping(e.target)) return;
	e.preventDefault();
	if (armed) runUndo(armed);
	else toast("Nothing to undo");
}

if (typeof window !== "undefined") {
	const w = window as { undoKeys?: (e: KeyboardEvent) => void };
	if (w.undoKeys) window.removeEventListener("keydown", w.undoKeys);
	w.undoKeys = onKeyDown;
	window.addEventListener("keydown", onKeyDown);
}
