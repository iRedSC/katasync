import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { AddressInput } from "#/components/address-input";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Tip } from "#/components/ui/tooltip";
import { optimism, type Patch } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { type LeadTime, MIN_MEASURED_POS } from "#/purchasing/forecast";
import type { PlaceAddress } from "#/server/places";
import { type SupplierRow, updateSupplier } from "#/server/purchasing";

type Supplier = SupplierRow["supplier"];

const input =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring";

// Edits a supplier's details. With unsaved changes, clicking outside doesn't
// close it, so a stray click can't lose them; it shakes and says why instead.
// Cancel or Esc still close it. `patch` shows the saved details on the page at
// once; without it the page shows them once reloaded.
export function SupplierDialog({
	supplier,
	leadTime,
	open,
	onOpenChange,
	patch,
}: {
	supplier: Supplier;
	// What reorder plans on, so the form can say when it isn't the typed one.
	leadTime: LeadTime;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	patch?: (saved: Supplier) => Patch;
}) {
	const [dirty, setDirty] = useState(false);
	const [blocked, setBlocked] = useState(false);
	const content = useRef<HTMLDivElement>(null);
	const change = (open: boolean) => {
		if (!open) {
			setDirty(false);
			setBlocked(false);
		}
		onOpenChange(open);
	};
	return (
		<Dialog open={open} onOpenChange={change}>
			<DialogContent
				showCloseButton={false}
				ref={content}
				onInteractOutside={(e) => {
					if (!dirty) return;
					e.preventDefault();
					setBlocked(true);
					if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
						content.current?.animate(
							[0, -6, 6, -4, 4, 0].map((x) => ({
								transform: `translateX(${x}px)`,
							})),
							{ duration: 300 },
						);
				}}
				onEscapeKeyDown={(e) => {
					// Esc closes an open address suggestion list first.
					if (
						e.target instanceof HTMLElement &&
						e.target.getAttribute("aria-expanded") === "true"
					)
						e.preventDefault();
				}}
				className="sm:max-w-2xl"
			>
				<DialogHeader>
					<DialogTitle>{supplier.name}</DialogTitle>
				</DialogHeader>
				<SupplierForm
					// Fresh fields each time it opens.
					key={String(open)}
					s={supplier}
					leadTime={leadTime}
					onDirty={(d) => {
						setDirty(d);
						if (!d) setBlocked(false);
					}}
					blocked={blocked}
					onDone={() => change(false)}
					patch={patch}
				/>
			</DialogContent>
		</Dialog>
	);
}

// Why the server would refuse these details, so the form can say so before the
// page shows them as saved.
function refusal(v: Supplier): string | null {
	if (v.name === "") return "A supplier needs a name";
	if (
		!(
			Number.isInteger(v.leadTimeDays) &&
			v.leadTimeDays >= 1 &&
			v.leadTimeDays <= 365
		)
	)
		return "Lead time must be a whole number of days, 1 to 365";
	if (
		!(Number.isInteger(v.coverDays) && v.coverDays >= 1 && v.coverDays <= 365)
	)
		return "Cover must be a whole number of days, 1 to 365";
	if (!(v.minimumOrder >= 0))
		return "Spend threshold must be a number, 0 or more";
	if (!(Number.isInteger(v.criticalThreshold) && v.criticalThreshold >= 1))
		return "Essential threshold must be a whole number, 1 or more";
	return null;
}

function SupplierForm({
	s,
	leadTime,
	onDirty,
	blocked,
	onDone,
	patch,
}: {
	s: Supplier;
	leadTime: LeadTime;
	onDirty: (dirty: boolean) => void;
	blocked: boolean;
	onDone: () => void;
	patch?: (saved: Supplier) => Patch;
}) {
	const [busy, setBusy] = useState(false);
	const form = useRef<HTMLFormElement>(null);

	// Dirty while any field differs from what was saved, so undoing an edit by
	// hand counts as clean again.
	const checkDirty = () =>
		onDirty(
			Array.from(form.current?.elements ?? []).some(
				(el) => el instanceof HTMLInputElement && el.value !== el.defaultValue,
			),
		);

	function fillAddress(address: PlaceAddress) {
		for (const [name, value] of Object.entries(address)) {
			const el = form.current?.elements.namedItem(name);
			if (el instanceof HTMLInputElement) el.value = value;
		}
		checkDirty();
	}

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const f = new FormData(e.currentTarget);
		const str = (k: string) => String(f.get(k) ?? "");
		// As the server stores them: blanks become empty, and the name is trimmed.
		const blank = (k: string) => str(k).trim() || null;
		const values = {
			name: str("name").trim(),
			contactName: blank("contactName"),
			email: blank("email"),
			phone: blank("phone"),
			address1: blank("address1"),
			address2: blank("address2"),
			city: blank("city"),
			region: blank("region"),
			postalCode: blank("postalCode"),
			country: blank("country"),
			paymentTerms: blank("paymentTerms"),
			notes: blank("notes"),
			poNotes: blank("poNotes"),
			leadTimeDays: Number(str("leadTimeDays")),
			coverDays: Number(str("coverDays")),
			minimumOrder: Number(str("minimumOrder") || 0),
			criticalThreshold: Number(str("criticalThreshold")),
		};
		const saved: Supplier = { ...s, ...values };
		const refused = refusal(saved);
		if (refused) {
			toast.error(refused);
			return;
		}
		const send = () => updateSupplier({ data: { id: s.id, ...values } });
		if (patch) {
			// Shown at once, so the form closes now. A save that fails says why,
			// and the page goes back to what it was.
			onDone();
			const r = await optimism.change({
				label: `${s.name}'s details`,
				patch: patch(saved),
				send,
			});
			if (r) toast.success(`Saved ${saved.name}`);
			return;
		}
		setBusy(true);
		const r = await optimism.change({ send });
		setBusy(false);
		if (!r) return;
		toast.success(`Saved ${saved.name}`);
		onDone();
	}

	return (
		<form
			ref={form}
			onSubmit={submit}
			onInput={checkDirty}
			className="grid gap-3 md:grid-cols-2"
		>
			<Field label="Name">
				<input name="name" required defaultValue={s.name} className={input} />
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
			<Field label="Address">
				<AddressInput
					name="address1"
					defaultValue={s.address1 ?? ""}
					onPick={fillAddress}
					className={input}
				/>
			</Field>
			<Field label="Address line 2">
				<input
					name="address2"
					defaultValue={s.address2 ?? ""}
					className={input}
				/>
			</Field>
			<div className="grid grid-cols-4 gap-3 md:col-span-2">
				<Field label="City">
					<input name="city" defaultValue={s.city ?? ""} className={input} />
				</Field>
				<Field label="State">
					<input
						name="region"
						defaultValue={s.region ?? ""}
						className={input}
					/>
				</Field>
				<Field label="ZIP">
					<input
						name="postalCode"
						defaultValue={s.postalCode ?? ""}
						className={input}
					/>
				</Field>
				<Field label="Country">
					<input
						name="country"
						defaultValue={s.country ?? ""}
						placeholder="US"
						className={input}
					/>
				</Field>
			</div>
			<div className="grid grid-cols-2 gap-3 md:col-span-2 md:grid-cols-4">
				<Field label="Lead time (days)">
					<input
						name="leadTimeDays"
						required
						inputMode="numeric"
						defaultValue={s.leadTimeDays}
						className={cn(input, "tabular-nums")}
					/>
					<span className="text-xs text-muted-foreground">
						{leadTime.measured
							? `Reorder uses ${leadTime.measured.days}, measured from the last ${leadTime.measured.pos} POs`
							: `Used until ${MIN_MEASURED_POS} POs arrive, then measured`}
					</span>
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
				<Field label="Spend threshold ($)">
					<input
						name="minimumOrder"
						inputMode="decimal"
						defaultValue={s.minimumOrder || ""}
						placeholder="None"
						className={cn(input, "tabular-nums")}
					/>
				</Field>
				<Field label="Essential threshold">
					<Tip content="Essentials needing order that make a PO ready, whatever its total">
						<input
							name="criticalThreshold"
							required
							inputMode="numeric"
							defaultValue={s.criticalThreshold}
							className={cn(input, "tabular-nums")}
						/>
					</Tip>
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
						className={input}
					/>
				</Field>
			</div>
			<DialogFooter className="items-center md:col-span-2">
				{blocked && (
					<span role="alert" className="mr-auto text-warning-text">
						You have unsaved changes. Save them, or Cancel to discard.
					</span>
				)}
				<Button type="button" size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
				<Button type="submit" size="sm" disabled={busy}>
					Save
				</Button>
			</DialogFooter>
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
