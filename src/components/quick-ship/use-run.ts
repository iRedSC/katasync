import { useMemo, useState } from "react";

// Work for one opening of quick ship: a lookup, a plan, or prices. Busy while
// any of this opening's work is out; each piece lets go only of its own hold,
// so one that answers early can't end another's wait. Work that answers
// after the opening has ended (end()) says nothing and touches nothing.
export function createRunner({
	setBusy,
	setError,
}: {
	setBusy: (busy: boolean) => void;
	setError: (error: string | null) => void;
}) {
	// Which opening of the dialog is on screen.
	const session = { current: 0 };
	let holds = 0;

	function end() {
		session.current++;
		holds = 0;
		setBusy(false);
	}

	// Resolves to undefined when it failed (and said so) or when its session
	// has ended.
	async function run<T>(work: () => Promise<T>) {
		const mine = session.current;
		const current = () => mine === session.current;
		holds++;
		setBusy(true);
		setError(null);
		try {
			const value = await work();
			return current() ? value : undefined;
		} catch (err) {
			if (current()) setError(err instanceof Error ? err.message : String(err));
			return undefined;
		} finally {
			if (current() && --holds === 0) setBusy(false);
		}
	}

	return { session, run, end };
}

export function useRun(setError: (error: string | null) => void) {
	const [busy, setBusy] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: setError is a state setter
	const runner = useMemo(() => createRunner({ setBusy, setError }), []);
	return { busy, ...runner };
}
