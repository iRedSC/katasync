import { toast } from "sonner";
import type { Outcome } from "#/lib/intent";

// What an undo says once its change is answered, as offerUndo wants it: what
// was undone when it saved, or null once a refusal has said why. A send that
// threw has already said why through the optimism engine.
export function undone(
	outcome: Outcome<unknown>,
	{ done, refusal }: { done: string; refusal: string },
): string | null {
	if (outcome.kind === "rejected")
		toast.error(`${refusal}: ${outcome.problem}`);
	return outcome.kind === "saved" ? done : null;
}
