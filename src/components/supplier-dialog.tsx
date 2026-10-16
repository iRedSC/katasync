import { useRouter } from "@tanstack/react-router";
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
import { cn } from "#/lib/utils";
import type { PlaceAddress } from "#/server/places";
import { type SupplierRow, updateSupplier } from "#/server/purchasing";

type Supplier = SupplierRow["supplier"];

const input =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring";

// Edits a supplier's details. With unsaved changes, clicking outside doesn't
// close it, so a stray click can't lose them; it shakes and says why instead.
// Cancel or Esc still close it.
export function SupplierDialog({
	supplier,
	open,
	onOpenChange,
}: {
	supplier: Supplier;
	open: boolean;
	onOpenChange: (open: boolean) => void;
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
					onDirty={(d) => {
						setDirty(d);
						if (!d) setBlocked(false);
					}}
					blocked={blocked}
					onDone={() => change(false)}
				/>
			</DialogContent>
		</Dialog>
	);
}

function SupplierForm({
	s,
	onDirty,
	blocked,
	onDone,
}: {
	s: Supplier;
	onDirty: (dirty: boolean) => void;
	blocked: boolean;
	onDone: () => void;
}) {
	const router = useRouter();
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
		setBusy(true);
		try {
			await updateSupplier({
				data: {
					id: s.id,
					name: str("name"),
					contactName: str("contactName"),
					email: str("email").trim(),
					phone: str("phone"),
					address1: str("address1"),
					address2: str("address2"),
					city: str("city"),
					region: str("region"),
					postalCode: str("postalCode"),
					country: str("country"),
					paymentTerms: str("paymentTerms"),
					notes: str("notes"),
					poNotes: str("poNotes"),
					leadTimeDays: Number(str("leadTimeDays")),
					coverDays: Number(str("coverDays")),
					minimumOrder: Number(str("minimumOrder") || 0),
					criticalThreshold: Number(str("criticalThreshold")),
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
				<Field label="Critical threshold">
					<input
						name="criticalThreshold"
						required
						inputMode="numeric"
						defaultValue={s.criticalThreshold}
						title="Critical products needing ordering that make a PO ready, whatever its total"
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
