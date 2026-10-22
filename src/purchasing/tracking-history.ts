// Packages followed before their scans were kept have none until Shippo is
// asked again. The PO page asks for them when opened, at most once an hour,
// so one Shippo has no history for isn't asked on every view.
const ASK_AGAIN_MS = 60 * 60_000;

export const lacksHistory = (
	t: {
		history: unknown[];
		service: string | null;
		checkedAt: Date | string | null;
	},
	now = Date.now(),
) =>
	t.history.length === 0 &&
	t.service === null &&
	(t.checkedAt === null ||
		now - new Date(t.checkedAt).getTime() > ASK_AGAIN_MS);
