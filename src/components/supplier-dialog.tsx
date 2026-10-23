import { X } from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { AddressInput } from "#/components/address-input";
import { CatalogSelect } from "#/components/catalog-picker";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import { optimism, type Patch } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import { type LeadTime, MIN_MEASURED_POS } from "#/purchasing/forecast";
import type { PlaceAddress } from "#/server/places";
import {
	type CatalogRow,
	listCatalogs,
	makeCatalog,
	type SupplierRow,
	setSupplierCarries,
	updateSupplier,
} from "#/server/purchasing";

type Supplier = SupplierRow["supplier"];

const input =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring";

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
				{open && <SupplierCatalogs supplier={supplier} />}
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
				(el) => el instanceof HTMLInputElement && el.value !== el.defaultValue,
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
			onInput={onInput}
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
					onPick={pickAddress}
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
					<Tip content="Essentials needing order that suggest a PO whatever its total. Twice as many: Order soon">
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

// The catalogs a supplier carries, as chips: it sells everything in them.
// Changes save at once, each with Undo; the supplier's terms for a catalog's
// products are kept when it stops carrying it, so carrying it again brings
// them back.
function SupplierCatalogs({ supplier }: { supplier: Supplier }) {
	const [all, setAll] = useState<CatalogRow[] | null>(null);
	useEffect(() => {
		listCatalogs().then(setAll);
	}, []);
	const carries = (c: CatalogRow) =>
		c.suppliers.some((s) => s.id === supplier.id);
	const carried = all?.filter(carries) ?? [];

	// Shown at once; put back if the server refuses.
	function mark(catalog: { id: number; name: string }, on: boolean) {
		setAll((list) => {
			const rest = (list ?? []).filter((c) => c.id !== catalog.id);
			const had = list?.find((c) => c.id === catalog.id);
			const base = had ?? { ...catalog, products: 0, suppliers: [] };
			const suppliers = on
				? [...base.suppliers, { id: supplier.id, name: supplier.name }]
				: base.suppliers.filter((s) => s.id !== supplier.id);
			return [...rest, { ...base, suppliers }].sort((a, b) =>
				a.name.localeCompare(b.name),
			);
		});
	}

	async function set(catalog: { id: number; name: string }, on: boolean) {
		mark(catalog, on);
		const send = () =>
			setSupplierCarries({
				data: { supplierId: supplier.id, catalogId: catalog.id, carried: on },
			});
		const r = await optimism.change({ send });
		if (!r) return mark(catalog, !on);
		toast.success(
			on
				? `${supplier.name} carries ${catalog.name}`
				: `${supplier.name} no longer carries ${catalog.name}`,
			{
				action: {
					label: "Undo",
					onClick: () => {
						mark(catalog, !on);
						optimism.change({
							send: () =>
								setSupplierCarries({
									data: {
										supplierId: supplier.id,
										catalogId: catalog.id,
										carried: !on,
									},
								}),
						});
					},
				},
			},
		);
	}

	async function make(name: string) {
		const r = await optimism.change({
			send: () => makeCatalog({ data: { name } }),
		});
		if (r) await set({ id: r.value, name }, true);
	}

	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="mr-1 text-muted-foreground">Carries</span>
			{all === null && <span className="text-muted-foreground">…</span>}
			{carried.map((c) => (
				<span
					key={c.id}
					className="inline-flex items-center gap-0.5 rounded-md bg-subtle py-0.5 pr-0.5 pl-2 text-sm"
				>
					{c.name}
					<span className="ml-1 text-xs text-muted-foreground tabular-nums">
						{formatCount(c.products)}
					</span>
					<button
						type="button"
						aria-label={`Stop carrying ${c.name}`}
						onClick={() => set(c, false)}
						className="rounded p-0.5 text-muted-foreground hover:bg-surface-strong hover:text-foreground"
					>
						<X className="size-3" />
					</button>
				</span>
			))}
			{all !== null && (
				<CatalogSelect
					value={null}
					catalogs={all.filter((c) => !carries(c))}
					onPick={(c) => c && set(c, true)}
					onMake={make}
					placeholder="Add catalog"
				/>
			)}
		</div>
	);
}
