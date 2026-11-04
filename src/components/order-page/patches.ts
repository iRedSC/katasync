import type { Outcome, Received } from "#/components/return-dialog";
import { optimistic, type Patch } from "#/lib/optimism";
import type { OrderDetail } from "#/server/orders";

// The order page's optimistic updates (routes/orders/$id.tsx).

// The page's data with changes the server hasn't confirmed laid over it.
export const orderData = optimistic<OrderDetail>("order");

// Receiving a return counts it against each line, and against the line's
// restocked count when it went back on a shelf (its own or a refurb's).
// Units counted back at cutover are taken last, as receiving takes them,
// and were already counted (and restocked, costing nothing). Undo takes it
// off again; one that took cutover units waits for the reload instead.
export const returnedPatch =
	(orderId: number, sign: 1 | -1) =>
	(received: Received[], outcome: Outcome): Patch =>
		orderData.patch(orderId, (d) => ({
			...d,
			lines: d.lines.map((l) => {
				const got = received.find((r) => r.lineId === l.id);
				if (!got) return l;
				const left = l.returnQuantity - l.returned - l.onBench.length;
				const fromCutover = sign === 1 ? Math.max(0, got.quantity - left) : 0;
				const n = sign * got.quantity;
				const shelved = outcome === "write_off" ? 0 : n;
				return {
					...l,
					returned: l.returned + n - fromCutover,
					counted: l.counted - fromCutover,
					restocked: l.restocked + shelved - fromCutover,
				};
			}),
		}));
export const reloadOnly = (orderId: number) =>
	orderData.patch(orderId, (d) => d);

// Taking a received return back: it leaves the Return card, and its units
// leave the line's returned (and restocked) counts.
export const takenBackPatch = (
	orderId: number,
	r: OrderDetail["returnsReceived"][number],
): Patch =>
	orderData.patch(orderId, (d) => ({
		...d,
		returnsReceived: d.returnsReceived.filter((x) => x.id !== r.id),
		lines: d.lines.map((l) =>
			l.id !== r.lineId
				? l
				: {
						...l,
						// Units it took off the cutover count are counted back.
						returned: l.returned - r.quantity + (r.cutoverQuantity ?? 0),
						counted: l.counted + (r.cutoverQuantity ?? 0),
						restocked:
							(r.restocked || r.refurb || r.preCutover
								? l.restocked - r.quantity
								: l.restocked) + (r.cutoverQuantity ?? 0),
					},
		),
	}));
