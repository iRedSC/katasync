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
import type { SupplierContact } from "#/purchasing/contacts";
import {
	addSupplierContact,
	type PurchaseOrderDetail,
} from "#/server/purchasing";

const box =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring";

// Stands in for Send while the supplier has no contacts: a name and email,
// and once saved the button is Send again. More contacts go in the supplier
// form. Ordering some other way stays under More.
export function AddEmail({
	supplier,
	patch,
}: {
	supplier: PurchaseOrderDetail["supplier"];
	patch: (contact: SupplierContact) => Patch;
}) {
	const [open, setOpen] = useState(false);
	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const contact = {
			name: String(form.get("name")).trim() || null,
			email: String(form.get("email")).trim(),
		};
		setOpen(false);
		const r = await optimism.change({
			label: `${supplier.name}'s contact`,
			patch: patch(contact),
			send: () => addSupplierContact({ data: { id: supplier.id, ...contact } }),
		});
		if (r) toast.success(`Saved ${supplier.name}'s contact`);
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
					<span className="font-medium">Who gets {supplier.name}'s POs</span>
					<input
						name="email"
						type="email"
						required
						placeholder="Email"
						aria-label="Email"
						// biome-ignore lint/a11y/noAutofocus: the popover opens for this
						autoFocus
						className={box}
					/>
					<input
						name="name"
						placeholder="Name (optional)"
						aria-label="Name"
						autoComplete="off"
						className={box}
					/>
					<Button type="submit" size="sm" className="self-end">
						Save
					</Button>
				</form>
			</PopoverContent>
		</Popover>
	);
}
