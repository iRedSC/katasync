// What a server function answers for a change it may refuse: what it made,
// or why not. A refusal means nothing was saved, and sending the same again
// would be refused again; a lost connection throws instead, and may have
// saved.
export type Answer<T> = { ok: true; value: T } | { ok: false; problem: string };

// Runs `work`, answering an error of one of the `refusals` kinds (the rules
// saying no, as in "Invoice INV-1 has only $20.00 open") as a refusal.
// Anything else still throws.
export async function answer<T>(
	refusals: readonly (abstract new (...args: never[]) => Error)[],
	work: () => Promise<T>,
): Promise<Answer<T>> {
	try {
		return { ok: true, value: await work() };
	} catch (error) {
		if (error instanceof Error && refusals.some((r) => error instanceof r))
			return { ok: false, problem: error.message };
		throw error;
	}
}
