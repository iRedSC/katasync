import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { pullPrimaryNow } from "#/server/catalog";

// A full pass of the primary store now, so SKUs just added there become
// products without waiting for the four-hourly sync. A pass takes a while,
// so a toast stays up until it's done and then says what came of it.
export function PullNow({ store }: { store: { name: string } }) {
	const router = useRouter();
	const [pulling, setPulling] = useState(false);

	async function pull() {
		setPulling(true);
		const id = toast.loading(`Pulling listings and orders from ${store.name}…`);
		try {
			const r = await pullPrimaryNow();
			if (r.state === "busy") {
				toast.info(`${r.store} is already syncing. Try again in a minute.`, {
					id,
				});
			} else if (r.state === "failed") {
				toast.error(`Couldn't pull from ${r.store}`, {
					id,
					description: r.error,
				});
			} else {
				toast.success(
					`Pulled ${r.store}. ${r.created === 1 ? "1 product" : `${r.created} products`} created.`,
					{
						id,
						description:
							r.problems.length > 0
								? `${r.problems.length} problems, see Diagnostics: ${r.problems.slice(0, 3).join("; ")}`
								: undefined,
					},
				);
			}
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err), { id });
		} finally {
			setPulling(false);
		}
	}

	return (
		<Tip content="Pull listings and orders now. New SKUs become products">
			<Button size="sm" variant="ghost" disabled={pulling} onClick={pull}>
				{pulling ? "Pulling…" : "Pull now"}
			</Button>
		</Tip>
	);
}
