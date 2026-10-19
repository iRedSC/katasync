// How long a refused tracking send keeps being tried on its own, and how
// often. Waits double from 30 seconds; the last try lands exactly at the
// end of the window, so a marketplace that's back by then still gets it.
export const RETRY_FOR_MS = 10 * 60_000;
const FIRST_WAIT_MS = 30_000;

// When to try again after the attempts-th refusal in a row, or null when
// the window is over.
export function nextRetry(
	firstFailedAt: Date,
	attempts: number,
	now: Date,
): Date | null {
	const deadline = firstFailedAt.getTime() + RETRY_FOR_MS;
	if (now.getTime() >= deadline) return null;
	const wait = FIRST_WAIT_MS * 2 ** Math.max(attempts - 1, 0);
	return new Date(Math.min(now.getTime() + wait, deadline));
}
