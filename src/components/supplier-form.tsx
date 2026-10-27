import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { AddressInput } from "#/components/address-input";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { optimism, type Patch } from "#/lib/optimism";
import { caretAfterDigits, digitsBefore, formatPhoneInput } from "#/lib/phone";
import { cn } from "#/lib/utils";
import {
	DEMAND_DAYS,
	type LeadTime,
	MIN_MEASURED_POS,
} from "#/purchasing/forecast";
import type { PlaceAddress } from "#/server/places";
import { type SupplierRow, updateSupplier } from "#/server/purchasing";

export type Supplier = SupplierRow["supplier"];

const box =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none transition-colors focus:border-ring aria-invalid:border-critical-text";

// The fields a picked address fills in. Editing any of them makes a pick that's
// still waiting on its details stale.
const addressFields = new Set([
	"address1",
	"address2",
	"city",
	"region",
	"postalCode",
	"country",
]);

// What suppliers' terms usually say, offered as the field is typed in.
const TERMS = [
	"Net 15",
	"Net 30",
	"Net 45",
	"Net 60",
	"Due on receipt",
	"Prepaid",
	"Credit card",
];

// Why the server would refuse these details, so the form can say so before the
// page shows them as saved.
function refusal(v: Supplier): string | null {
	if (v.name === "") return "A supplier needs a name";
	if (v.code === "") return "A supplier needs a short name";
	if (
		!(
			Number.isInteger(v.leadTimeDays) &&
			v.leadTimeDays >= 1 &&
			v.leadTimeDays <= 365
		)
	)
		return "Lead time must be a whole number of days, 1 to 365";
	if (
		!(
			Number.isInteger(v.coverDays) &&
			v.coverDays >= 1 &&
			v.coverDays <= DEMAND_DAYS
		)
	)
		return `Cover must be a whole number of days, 1 to ${DEMAND_DAYS}`;
	if (!(v.minimumOrder >= 0))
		return "Spend threshold must be a number, 0 or more";
	if (!(Number.isInteger(v.criticalThreshold) && v.criticalThreshold >= 1))
		return "Essential threshold must be a whole number, 1 or more";
	return null;
}

// A supplier's details, in sections. `onDirty` hears whether anything
// differs from what was saved, so whoever shows the form can keep a stray
// click or link from losing the edits. `patch` shows the saved details on the
// page behind at once; the form itself closes only once the server has them.
export function SupplierForm({
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
	// Something tried to close the form over unsaved edits.
	blocked: boolean;
	onDone: () => void;
	patch?: (saved: Supplier) => Patch;
}) {
	const [busy, setBusy] = useState(false);
	// The last save didn't go through; the edits are still here.
	const [failed, setFailed] = useState(false);
	const form = useRef<HTMLFormElement>(null);
	// Bumped by each edit to an address field.
	const addressEdits = useRef(0);
	// The latest address pick. Only it may still fill the address in.
	const latestPick = useRef<symbol | null>(null);
	// A pick still waiting on its details is dropped once the form is gone.
	useEffect(
		() => () => {
			latestPick.current = null;
		},
		[],
	);

	// Dirty while any field differs from what was saved, so undoing an edit by
	// hand counts as clean again.
	const checkDirty = () =>
		onDirty(
			Array.from(form.current?.elements ?? []).some(
				(el) =>
					(el instanceof HTMLInputElement ||
						el instanceof HTMLTextAreaElement) &&
					el.value !== el.defaultValue,
			),
		);

	// Fills in a picked address once its lookup finishes, if it's still wanted:
	// no newer pick, no edit to an address field, and no save since. Otherwise it
	// is dropped and the form keeps what's in it. A failed lookup is shown only
	// while it's wanted.
	function pickAddress(lookup: Promise<PlaceAddress>) {
		const pick = Symbol();
		const edits = addressEdits.current;
		latestPick.current = pick;
		const wanted = () =>
			latestPick.current === pick && addressEdits.current === edits;
		return lookup.then(
			(address) => {
				if (!wanted()) return;
				for (const [name, value] of Object.entries(address)) {
					const el = form.current?.elements.namedItem(name);
					if (el instanceof HTMLInputElement) el.value = value;
				}
				checkDirty();
			},
			(error: unknown) => {
				if (wanted()) throw error;
			},
		);
	}

	const onInput = (e: FormEvent<HTMLFormElement>) => {
		if (
			e.target instanceof HTMLInputElement &&
			addressFields.has(e.target.name)
		)
			addressEdits.current++;
		checkDirty();
	};

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		// What's saved is what's on the form now, so a pick still looking up
		// its address can't change it after this.
		latestPick.current = null;
		const f = new FormData(e.currentTarget);
		const str = (k: string) => String(f.get(k) ?? "");
		// As the server stores them: blanks become empty, and the name is trimmed.
		const blank = (k: string) => str(k).trim() || null;
		const phone = blank("phone");
		const values = {
			name: str("name").trim(),
			code: str("code").trim(),
			contactName: blank("contactName"),
			email: blank("email"),
			phone: phone && formatPhoneInput(phone).trim(),
			address1: blank("address1"),
			address2: blank("address2"),
			city: blank("city"),
			region: blank("region")?.toUpperCase() ?? null,
			postalCode: blank("postalCode"),
			country: blank("country")?.toUpperCase() ?? null,
			paymentTerms: blank("paymentTerms"),
			notes: blank("notes"),
			poNotes: blank("poNotes"),
			leadTimeDays: Number(str("leadTimeDays")),
			coverDays: Number(str("coverDays")),
			minimumOrder: Number(str("minimumOrder").replace(/[$,\s]/g, "") || 0),
			criticalThreshold: Number(str("criticalThreshold")),
		};
		const saved: Supplier = { ...s, ...values };
		const refused = refusal(saved);
		if (refused) {
			toast.error(refused);
			return;
		}
		// The form stays, as typed, until the server has it: closing it first
		// would lose every edit if the save fails.
		setFailed(false);
		setBusy(true);
		const send = () => updateSupplier({ data: { id: s.id, ...values } });
		const r = await optimism.change(
			patch
				? { label: `${s.name}'s details`, patch: patch(saved), send }
				: { send },
		);
		setBusy(false);
		if (!r) {
			setFailed(true);
			shake(form.current);
			return;
		}
		toast.success(`Saved ${saved.name}`);
		onDone();
	}

	return (
		<form
			ref={form}
			onSubmit={submit}
			onInput={onInput}
			className="flex flex-col gap-5"
		>
			<Section title="Contact">
				<Field label="Name">
					<input name="name" required defaultValue={s.name} className={box} />
				</Field>
				<Field label="Short name">
					<input
						name="code"
						required
						defaultValue={s.code}
						autoComplete="off"
						className={box}
					/>
				</Field>
				<Field label="Contact person">
					<input
						name="contactName"
						defaultValue={s.contactName ?? ""}
						autoComplete="off"
						className={box}
					/>
				</Field>
				<Field label="Email POs to">
					<EmailInput defaultValue={s.email ?? ""} />
				</Field>
				<Field label="Phone">
					<PhoneInput defaultValue={s.phone ?? ""} />
				</Field>
			</Section>

			<Section title="Address">
				<Field label="Street" wide>
					<AddressInput
						name="address1"
						defaultValue={s.address1 ?? ""}
						onPick={pickAddress}
						className={box}
					/>
				</Field>
				<Field label="Suite, unit, building" wide>
					<input
						name="address2"
						defaultValue={s.address2 ?? ""}
						className={box}
					/>
				</Field>
				<div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 md:col-span-2">
					<Field label="City">
						<input name="city" defaultValue={s.city ?? ""} className={box} />
					</Field>
					<Field label="State">
						<input
							name="region"
							defaultValue={s.region ?? ""}
							maxLength={3}
							className={cn(box, "uppercase")}
						/>
					</Field>
					<Field label="ZIP">
						<input
							name="postalCode"
							defaultValue={s.postalCode ?? ""}
							inputMode="numeric"
							className={cn(box, "tabular-nums")}
						/>
					</Field>
					<Field label="Country">
						<input
							name="country"
							defaultValue={s.country ?? ""}
							placeholder="US"
							maxLength={2}
							className={cn(box, "uppercase")}
						/>
					</Field>
				</div>
			</Section>

			<Section
				title="Reordering"
				note="How reorder plans this supplier's POs"
				cols={4}
			>
				<Field
					label="Lead time"
					hint={
						leadTime.measured
							? `Reorder uses ${leadTime.measured.days}, measured from the last ${leadTime.measured.pos} POs`
							: `Used until ${MIN_MEASURED_POS} POs arrive, then measured`
					}
				>
					<Adorned after="days">
						<input
							name="leadTimeDays"
							required
							inputMode="numeric"
							defaultValue={s.leadTimeDays}
							className={cn(box, "pr-11 tabular-nums")}
						/>
					</Adorned>
				</Field>
				<Field label="Cover" hint="POs restock what sold over these days">
					<Adorned after="days">
						<input
							name="coverDays"
							required
							inputMode="numeric"
							defaultValue={s.coverDays}
							className={cn(box, "pr-11 tabular-nums")}
						/>
					</Adorned>
				</Field>
				<Field label="Spend threshold" hint="A suggestion is ready at this">
					<Adorned before="$">
						<input
							name="minimumOrder"
							inputMode="decimal"
							defaultValue={s.minimumOrder || ""}
							placeholder="None"
							className={cn(box, "pl-5 tabular-nums")}
						/>
					</Adorned>
				</Field>
				<Field label="Essential threshold">
					<Tip content="Essentials needing order that suggest a PO whatever its total. Twice as many: Order soon">
						<input
							name="criticalThreshold"
							required
							inputMode="numeric"
							defaultValue={s.criticalThreshold}
							className={cn(box, "tabular-nums")}
						/>
					</Tip>
				</Field>
			</Section>

			<Section title="Terms and notes">
				<Field label="Payment terms">
					<TermsInput defaultValue={s.paymentTerms ?? ""} />
				</Field>
				<Field label="Notes" hint="Only for us">
					<textarea
						name="notes"
						rows={2}
						defaultValue={s.notes ?? ""}
						placeholder="e.g. Free shipping over $1,500"
						className={cn(box, "h-auto min-h-8 resize-y py-1.5")}
					/>
				</Field>
				<Field label="Printed on every PO" wide>
					<textarea
						name="poNotes"
						rows={2}
						defaultValue={s.poNotes ?? ""}
						className={cn(box, "h-auto min-h-8 resize-y py-1.5")}
					/>
				</Field>
			</Section>

			<div className="flex flex-col-reverse items-center gap-2 border-t pt-4 sm:flex-row sm:justify-end">
				{failed && !busy && (
					<span role="alert" className="mr-auto text-critical-text">
						Not saved. Your edits are still here.
					</span>
				)}
				{blocked && !failed && (
					<span role="alert" className="mr-auto text-warning-text">
						Unsaved changes. Save them, or Cancel to discard.
					</span>
				)}
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={busy}
					onClick={onDone}
				>
					Cancel
				</Button>
				<Button type="submit" size="sm" disabled={busy}>
					{busy ? "Saving…" : "Save"}
				</Button>
			</div>
		</form>
	);
}

function Section({
	title,
	note,
	cols = 2,
	children,
}: {
	title: string;
	note?: string;
	cols?: 2 | 4;
	children: ReactNode;
}) {
	return (
		<fieldset className="flex flex-col gap-3">
			<legend className="mb-2 flex items-baseline gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
				{title}
				{note && (
					<span className="font-normal tracking-normal normal-case">
						{note}
					</span>
				)}
			</legend>
			<div
				className={cn(
					"grid gap-3",
					cols === 4 ? "grid-cols-2 md:grid-cols-4" : "md:grid-cols-2",
				)}
			>
				{children}
			</div>
		</fieldset>
	);
}

function Field({
	label,
	hint,
	wide = false,
	children,
}: {
	label: string;
	hint?: string;
	wide?: boolean;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the input is passed as children
		<label className={cn("flex flex-col gap-1", wide && "md:col-span-2")}>
			<span className="text-muted-foreground">{label}</span>
			{children}
			{hint && <span className="text-xs text-faint">{hint}</span>}
		</label>
	);
}

// A unit beside the number, inside the box: "$" before, "days" after.
function Adorned({
	before,
	after,
	children,
}: {
	before?: string;
	after?: string;
	children: ReactNode;
}) {
	return (
		<div className="relative">
			{before && (
				<span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-muted-foreground">
					{before}
				</span>
			)}
			{children}
			{after && (
				<span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground">
					{after}
				</span>
			)}
		</div>
	);
}

// Turns red once left holding something that isn't an email, and says so.
function EmailInput({ defaultValue }: { defaultValue: string }) {
	const [bad, setBad] = useState(false);
	const id = useId();
	return (
		<>
			<input
				name="email"
				type="email"
				defaultValue={defaultValue}
				autoComplete="off"
				placeholder="orders@supplier.com"
				aria-invalid={bad}
				aria-describedby={bad ? id : undefined}
				onBlur={(e) => setBad(!e.currentTarget.validity.valid)}
				onInput={(e) => bad && setBad(!e.currentTarget.validity.valid)}
				className={box}
			/>
			{bad && (
				<span id={id} className="text-xs text-critical-text">
					Not an email address
				</span>
			)}
		</>
	);
}

// Shapes a US number as it's typed, keeping the caret after the same digit.
// Deleting a bracket or dash leaves it be until the next keystroke, so
// Backspace never seems stuck.
function PhoneInput({ defaultValue }: { defaultValue: string }) {
	const shown = defaultValue && formatPhoneInput(defaultValue);
	const last = useRef(shown);
	return (
		<input
			name="phone"
			type="tel"
			defaultValue={shown}
			autoComplete="off"
			placeholder="(555) 123-4567"
			onInput={(e) => {
				const el = e.currentTarget;
				const was = last.current;
				last.current = el.value;
				const deleting = (e.nativeEvent as InputEvent).inputType?.startsWith(
					"delete",
				);
				// Only a bracket, space, or dash went: leave it until the next key.
				if (deleting && el.value.replace(/\D/g, "") === was.replace(/\D/g, ""))
					return;
				const at = el.selectionStart ?? el.value.length;
				const digits = digitsBefore(el.value, at);
				const next = formatPhoneInput(el.value);
				if (next === el.value) return;
				const typedAtEnd = at === el.value.length;
				el.value = next;
				last.current = next;
				const caret = typedAtEnd ? next.length : caretAfterDigits(next, digits);
				el.setSelectionRange(caret, caret);
			}}
			className={cn(box, "tabular-nums")}
		/>
	);
}

// Free text, with the usual terms offered as it's typed.
function TermsInput({ defaultValue }: { defaultValue: string }) {
	const id = useId();
	return (
		<>
			<input
				name="paymentTerms"
				list={id}
				defaultValue={defaultValue}
				placeholder="e.g. Net 30"
				className={box}
			/>
			<datalist id={id}>
				{TERMS.map((t) => (
					<option key={t} value={t} />
				))}
			</datalist>
		</>
	);
}
