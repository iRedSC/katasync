import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Badge, Card, Page } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatCount, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import {
	listSuppliers,
	type SupplierRow,
	updateSupplier,
} from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/suppliers")({
	loader: () => listSuppliers(),
	component: Suppliers,
});

function Suppliers() {
	const rows = Route.useLoaderData();
	const [editing, setEditing] = useState<number | null>(null);

	return (
		<Page title="Suppliers" back={{ to: "/purchasing" }} narrow>
			<Card flush>
				<table className="w-full">
					<thead>
						<tr className="border-b bg-[#f7f7f7] text-left text-xs text-muted-foreground">
							<th className="px-4 py-2 font-medium">Supplier</th>
							<th className="hidden px-4 py-2 font-medium md:table-cell">
								Email
							</th>
							<th className="px-4 py-2 text-right font-medium">Products</th>
							<th className="px-4 py-2 text-right font-medium">Lead time</th>
							<th className="px-4 py-2 text-right font-medium">Minimum</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) =>
							editing === r.supplier.id ? (
								<tr key={r.supplier.id} className="border-t first:border-t-0">
									<td colSpan={5}>
										<SupplierForm row={r} onDone={() => setEditing(null)} />
									</td>
								</tr>
							) : (
								<tr
									key={r.supplier.id}
									onClick={() => setEditing(r.supplier.id)}
									className="cursor-pointer border-t first:border-t-0 hover:bg-[#f7f7f7]"
								>
									<td className="w-full max-w-0 px-4 py-2.5">
										<div className="flex items-center gap-2">
											<span className="truncate font-medium">
												{r.supplier.name}
											</span>
											{r.openOrders > 0 && (
												<Badge>{r.openOrders} on order</Badge>
											)}
										</div>
										<div className="text-xs text-muted-foreground">
											{r.supplier.code}
										</div>
									</td>
									<td className="hidden px-4 py-2.5 md:table-cell">
										{r.supplier.email ? (
											<span className="truncate">{r.supplier.email}</span>
										) : (
											<Badge tone="warning">No email</Badge>
										)}
									</td>
									<td className="px-4 py-2.5 text-right tabular-nums">
										{formatCount(r.products)}
									</td>
									<td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums">
										{r.supplier.leadTimeDays} days
									</td>
									<td className="px-4 py-2.5 text-right tabular-nums">
										{r.supplier.minimumOrder > 0
											? formatMoney(r.supplier.minimumOrder)
											: "—"}
									</td>
								</tr>
							),
						)}
					</tbody>
				</table>
			</Card>
			<p className="px-1 text-muted-foreground">
				A product is reordered once its stock would run out within the lead
				time, then bought to last the cover days on top. A supplier's suggested
				PO is ready once it reaches their minimum.
			</p>
		</Page>
	);
}

const input =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring";

function SupplierForm({
	row,
	onDone,
}: {
	row: SupplierRow;
	onDone: () => void;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const s = row.supplier;

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const f = new FormData(e.currentTarget);
		const str = (k: string) => String(f.get(k) ?? "");
		setBusy(true);
		try {
			await updateSupplier({
				data: {
					id: s.id,
					name: str("name"),
					contactName: str("contactName"),
					email: str("email").trim(),
					phone: str("phone"),
					paymentTerms: str("paymentTerms"),
					notes: str("notes"),
					poNotes: str("poNotes"),
					leadTimeDays: Number(str("leadTimeDays")),
					coverDays: Number(str("coverDays")),
					minimumOrder: Number(str("minimumOrder") || 0),
				},
			});
			await router.invalidate();
			toast.success(`Saved ${str("name")}`);
			onDone();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form
			onSubmit={submit}
			onKeyDown={(e) => e.key === "Escape" && onDone()}
			className="grid gap-3 bg-[#f7f7f7] px-4 py-4 md:grid-cols-2"
		>
			<Field label="Name">
				<input
					name="name"
					required
					defaultValue={s.name}
					// biome-ignore lint/a11y/noAutofocus: opened to edit this
					autoFocus
					className={input}
				/>
			</Field>
			<Field label="Contact">
				<input
					name="contactName"
					defaultValue={s.contactName ?? ""}
					className={input}
				/>
			</Field>
			<Field label="Email POs to">
				<input
					name="email"
					type="email"
					defaultValue={s.email ?? ""}
					className={input}
				/>
			</Field>
			<Field label="Phone">
				<input name="phone" defaultValue={s.phone ?? ""} className={input} />
			</Field>
			<div className="grid grid-cols-3 gap-3 md:col-span-2">
				<Field label="Lead time (days)">
					<input
						name="leadTimeDays"
						required
						inputMode="numeric"
						defaultValue={s.leadTimeDays}
						className={cn(input, "tabular-nums")}
					/>
				</Field>
				<Field label="Cover (days)">
					<input
						name="coverDays"
						required
						inputMode="numeric"
						defaultValue={s.coverDays}
						className={cn(input, "tabular-nums")}
					/>
				</Field>
				<Field label="Minimum order ($)">
					<input
						name="minimumOrder"
						inputMode="decimal"
						defaultValue={s.minimumOrder || ""}
						placeholder="None"
						className={cn(input, "tabular-nums")}
					/>
				</Field>
			</div>
			<Field label="Payment terms">
				<input
					name="paymentTerms"
					defaultValue={s.paymentTerms ?? ""}
					placeholder="e.g. Net 30"
					className={input}
				/>
			</Field>
			<Field label="Notes (only for us)">
				<input name="notes" defaultValue={s.notes ?? ""} className={input} />
			</Field>
			<div className="md:col-span-2">
				<Field label="Printed on every PO">
					<input
						name="poNotes"
						defaultValue={s.poNotes ?? ""}
						placeholder="e.g. Ship UPS Ground on our account"
						className={input}
					/>
				</Field>
			</div>
			<div className="flex gap-2 md:col-span-2">
				<Button type="submit" size="sm" disabled={busy}>
					Save
				</Button>
				<Button type="button" size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the input is passed as children
		<label className="flex flex-col gap-1">
			<span className="text-muted-foreground">{label}</span>
			{children}
		</label>
	);
}
