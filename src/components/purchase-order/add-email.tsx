import { Mail } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { optimism, type Patch } from "#/lib/optimism";
import {
	type PurchaseOrderDetail,
	setSupplierEmail,
} from "#/server/purchasing";

// Stands in for Send while the supplier has no email: one field, and once
// saved the button is Send again. Ordering some other way stays under More.
export function AddEmail({
	supplier,
	patch,
}: {
	supplier: PurchaseOrderDetail["supplier"];
	patch: (email: string) => Patch;
}) {
	const [open, setOpen] = useState(false);
	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const email = String(new FormData(e.currentTarget).get("email")).trim();
		setOpen(false);
		const r = await optimism.change({
			label: `${supplier.name}'s email`,
			patch: patch(email),
			send: () => setSupplierEmail({ data: { id: supplier.id, email } }),
		});
		if (r) toast.success(`Saved ${supplier.name}'s email`);
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button size="sm">
					<Mail />
					Add email to send
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-72 p-3">
				<form onSubmit={submit} className="flex flex-col gap-2">
					<label htmlFor="supplier-email" className="font-medium">
						{supplier.name}'s email
					</label>
					<input
						id="supplier-email"
						name="email"
						type="email"
						required
						// biome-ignore lint/a11y/noAutofocus: the popover opens for this one field
						autoFocus
						className="h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring"
					/>
					<Button type="submit" size="sm" className="self-end">
						Save
					</Button>
				</form>
			</PopoverContent>
		</Popover>
	);
}
