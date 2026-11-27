import type { KeyboardEvent } from "react";
import type { Step } from "./types";

// The keys quick ship answers wherever the focus is in its dialog.
export function dialogKeys({
	step,
	back,
	toggleHazmat,
	toggleNewDefault,
	toggleCompanion,
	companions,
}: {
	step: Step;
	back: () => void;
	toggleHazmat: () => void;
	toggleNewDefault: () => void;
	toggleCompanion: () => void;
	// How many other orders could share this box.
	companions: number;
}) {
	return (e: KeyboardEvent) => {
		// An Enter typed in a field finishes that step only. Without this,
		// the same keypress lands on the next step's button and presses it.
		if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
			e.preventDefault();
		}
		if (e.key === "Escape") {
			e.preventDefault();
			back();
		}
		// Ctrl, not a letter: the box step types box names. Also keeps
		// the browser's history page from opening.
		if (e.ctrlKey && e.key.toLowerCase() === "h" && step === "package") {
			e.preventDefault();
			toggleHazmat();
		}
		if (e.ctrlKey && e.key.toLowerCase() === "d" && step === "package") {
			e.preventDefault();
			toggleNewDefault();
		}
		if (
			// Tab, not a letter: the box step types box names.
			e.key === "Tab" &&
			step === "package" &&
			companions
		) {
			e.preventDefault();
			toggleCompanion();
		}
	};
}
