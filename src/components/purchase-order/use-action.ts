import { useState } from "react";
import { toast } from "sonner";
import { optimism, type Patch } from "#/lib/optimism";

// Changes go through the optimism engine, in order. `run` waits for the
// server, for changes whose outcome the page can't guess, such as sending or
// adding a product; its control stays busy until then. `save` shows its patch
// at once and doesn't hold anything up. Both resolve to { value } once the
// server has it and to null once it has failed and said why, since many
// changes return nothing.
export function useAction() {
	const [busy, setBusy] = useState(false);
	async function run<T>(send: () => Promise<T>, success?: (r: T) => string) {
		setBusy(true);
		const r = await optimism.change({ send });
		setBusy(false);
		if (r && success) toast.success(success(r.value));
		return r;
	}
	async function save<T>(change: {
		label: string;
		patch: Patch | readonly Patch[];
		send: () => Promise<T>;
		success?: (r: T) => string;
	}) {
		const r = await optimism.change(change);
		if (r && change.success) toast.success(change.success(r.value));
		return r;
	}
	return { busy, run, save };
}
