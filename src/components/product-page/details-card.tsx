import { type ReactNode, useRef, useState } from "react";
import { Card } from "#/components/page";
import {
	formatBox,
	poundsOunces,
} from "#/components/profit-page/shipping-dims";
import {
	GRAMS_PER_OUNCE,
	inches,
	MM_PER_INCH,
} from "#/components/quick-ship/units";
import { shake } from "#/components/shake";
import { formatCount, formatDate, formatMoney } from "#/lib/format";
import { optimism, optimistic } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { ProductDetail } from "#/server/catalog";
import { updateProduct } from "#/server/catalog/product-edits";
import { AerosolToggle, CriticalToggle, InsureToggle } from "./flag-toggles";

type Product = ProductDetail["product"];
// What one save changes, as updateProduct takes it: null clears a field.
type Edit = Omit<Parameters<typeof updateProduct>[0]["data"], "productId">;

// The product page's data, patched under the same key as the page's own.
const productData = optimistic<ProductDetail>("product");

const text = (v: string | null) => v?.trim() || null;
const mm = (v: number | null) =>
	v === null ? null : Math.round(v * MM_PER_INCH);

// The product as the edit leaves it, as updateProductDetails stores it.
function applied(p: Product, e: Edit): Product {
	const next = { ...p };
	if (e.name !== undefined) next.name = e.name.trim();
	if (e.variantName !== undefined) next.variantName = text(e.variantName);
	if (e.category !== undefined) next.category = text(e.category);
	if (e.barcode !== undefined) next.barcode = text(e.barcode);
	if (e.unitCost !== undefined) {
		next.unitCost = e.unitCost;
		next.unitCostUpdatedAt =
			e.unitCost === null
				? null
				: e.unitCostSetAt
					? new Date(e.unitCostSetAt)
					: new Date();
	}
	if (e.weightOz !== undefined)
		next.weightGrams =
			e.weightOz === null ? null : Math.round(e.weightOz * GRAMS_PER_OUNCE);
	if (e.lengthIn !== undefined) next.lengthMm = mm(e.lengthIn);
	if (e.widthIn !== undefined) next.widthMm = mm(e.widthIn);
	if (e.heightIn !== undefined) next.heightMm = mm(e.heightIn);
	return next;
}

// The edit that puts back what `e` changes.
function reverse(p: Product, e: Edit): Edit {
	const inch = (v: number | null) => (v === null ? null : v / MM_PER_INCH);
	const was: Required<Omit<Edit, "unitCostSetAt">> = {
		name: p.name,
		variantName: p.variantName,
		category: p.category,
		barcode: p.barcode,
		unitCost: p.unitCost,
		weightOz: p.weightGrams === null ? null : p.weightGrams / GRAMS_PER_OUNCE,
		lengthIn: inch(p.lengthMm),
		widthIn: inch(p.widthMm),
		heightIn: inch(p.heightMm),
	};
	const back = Object.fromEntries(
		Object.keys(e)
			.filter((k) => k !== "unitCostSetAt")
			.map((k) => [k, was[k as keyof typeof was]]),
	) as Edit;
	// A cost put back keeps the day it was set.
	if (back.unitCost != null && p.unitCostUpdatedAt)
		back.unitCostSetAt = new Date(p.unitCostUpdatedAt).toISOString();
	return back;
}

// Saves an edit at once, then offers to undo it. `what` names the field, as
// in "Barcode cleared".
export async function editProduct(p: Product, e: Edit, what: string) {
	const label = `${what} of ${p.sku}`;
	const send = (edit: Edit) => () =>
		updateProduct({ data: { productId: p.id, ...edit } });
	const patch = (edit: Edit) =>
		productData.patch(p.id, (d) => ({
			...d,
			product: applied(d.product, edit),
		}));
	const back = reverse(p, e);
	const r = await optimism.change({ label, patch: patch(e), send: send(e) });
	if (!r) return;
	const clears = Object.values(e).every((v) => v === null);
	offerUndo(`${what} ${clears ? "cleared" : "saved"}`, {
		tone: "success",
		undo: async () => {
			const undone = await optimism.change({
				label,
				patch: patch(back),
				send: send(back),
			});
			return undone && `${what} put back`;
		},
	});
}

// What a typed value saves as: a value, null to clear it, or refused.
type Parse<T> = (typed: string) => { value: T } | null;

const parseText: Parse<string | null> = (t) => ({ value: t.trim() || null });
const parsePositive: Parse<number | null> = (t) => {
	if (t.trim() === "") return { value: null };
	const n = Number(t.replace(/[$,\s]/g, ""));
	return Number.isFinite(n) && n > 0 ? { value: n } : null;
};
const parseCost: Parse<number | null> = (t) => {
	if (t.trim() === "") return { value: null };
	const n = Number(t.replace(/[$,\s]/g, ""));
	return Number.isFinite(n) && n >= 0 ? { value: n } : null;
};

const fieldBox =
	"h-7 w-full min-w-0 rounded-md border border-input bg-white px-2 tabular-nums outline-none focus:border-ring focus:ring-1 focus:ring-ring";

// One value typed over in place. Enter or leaving saves; empty clears, unless
// `parse` refuses it, which shakes and keeps it open. Escape leaves it as it
// was.
export function InlineInput<T>({
	initial,
	placeholder,
	label,
	parse,
	onSave,
	onDone,
	className,
}: {
	initial: string;
	placeholder?: string;
	label: string;
	parse: Parse<T>;
	onSave: (value: T) => void;
	onDone: () => void;
	className?: string;
}) {
	const [typed, setTyped] = useState(initial);
	const ref = useRef<HTMLInputElement>(null);
	const cancelled = useRef(false);
	function commit() {
		if (cancelled.current || typed.trim() === initial.trim()) return onDone();
		const parsed = parse(typed);
		if (!parsed) {
			shake(ref.current);
			ref.current?.setAttribute("aria-invalid", "true");
			return;
		}
		onDone();
		onSave(parsed.value);
	}
	return (
		<input
			ref={ref}
			// biome-ignore lint/a11y/noAutofocus: opened by clicking the value
			autoFocus
			value={typed}
			placeholder={placeholder}
			aria-label={label}
			onChange={(e) => {
				setTyped(e.target.value);
				e.target.removeAttribute("aria-invalid");
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				else if (e.key === "Escape") {
					// Not the page's Escape, which goes back.
					e.preventDefault();
					cancelled.current = true;
					e.currentTarget.blur();
				}
			}}
			onBlur={commit}
			className={cn(fieldBox, "aria-invalid:border-critical-border", className)}
		/>
	);
}

type FieldKey = "type" | "barcode" | "cost" | "weight" | "box";

const ADD_LABELS: Record<FieldKey, string> = {
	type: "Type",
	barcode: "Barcode",
	cost: "Cost",
	weight: "Weight",
	box: "Box",
};

// Only what's filled in. Empty fields aren't worth a glance, so they're
// offered as small links to fill in instead. Each value is typed over in
// place; clearing one takes its row away, and every change can be undone.
export function DetailsCard({ d }: { d: ProductDetail }) {
	const p = d.product;
	const [editing, setEditing] = useState<FieldKey | null>(null);
	const done = () => setEditing(null);
	// Type, vendor, and tags come from Shopify when we don't have our own.
	const shopifyType = d.listings.find((l) => l.productType)?.productType;
	const type = p.category ?? shopifyType;
	const vendor = d.listings.find((l) => l.vendor)?.vendor;
	const tags = [...new Set(d.listings.flatMap((l) => l.tags))].sort();
	const box =
		p.lengthMm && p.widthMm && p.heightMm
			? ([p.lengthMm, p.widthMm, p.heightMm] as [number, number, number])
			: null;

	const filled: Record<FieldKey, boolean> = {
		type: Boolean(type),
		barcode: Boolean(p.barcode),
		cost: p.unitCost !== null,
		weight: Boolean(p.weightGrams),
		box: box !== null,
	};
	const shown = (k: FieldKey) => filled[k] || editing === k;
	const missing = (Object.keys(filled) as FieldKey[]).filter((k) => !shown(k));

	const rows: [string, ReactNode][] = [];
	const row = (label: string, value: ReactNode) => rows.push([label, value]);
	if (shown("type"))
		row(
			"Type",
			editing === "type" ? (
				<InlineInput
					initial={p.category ?? ""}
					placeholder={shopifyType ?? "e.g. Flat Box"}
					label="Type"
					parse={parseText}
					onSave={(category) => editProduct(p, { category }, "Type")}
					onDone={done}
				/>
			) : (
				<Value onEdit={() => setEditing("type")}>
					{type}
					{!p.category && (
						<span className="ml-2 text-muted-foreground">from Shopify</span>
					)}
				</Value>
			),
		);
	if (vendor) row("Vendor", vendor);
	if (tags.length > 0) row("Tags", tags.join(", "));
	if (shown("cost"))
		row(
			"Cost",
			editing === "cost" ? (
				<InlineInput
					initial={p.unitCost === null ? "" : String(p.unitCost)}
					placeholder="Each"
					label={`Cost of one ${p.sku}`}
					parse={parseCost}
					onSave={(unitCost) => editProduct(p, { unitCost }, "Cost")}
					onDone={done}
					className="w-28 text-right"
				/>
			) : (
				<Value onEdit={() => setEditing("cost")}>
					{formatMoney(p.unitCost)}
					<span className="ml-2 text-muted-foreground">
						{p.unitCostUpdatedAt
							? `set ${formatDate(p.unitCostUpdatedAt)}`
							: "date unknown"}
					</span>
				</Value>
			),
		);
	if (shown("barcode"))
		row(
			"Barcode",
			editing === "barcode" ? (
				<InlineInput
					initial={p.barcode ?? ""}
					placeholder="UPC or EAN"
					label="Barcode"
					parse={parseText}
					onSave={(barcode) => editProduct(p, { barcode }, "Barcode")}
					onDone={done}
				/>
			) : (
				<Value onEdit={() => setEditing("barcode")}>{p.barcode}</Value>
			),
		);
	if (p.closeAt !== null)
		row(
			"Close at",
			`Shows 0 on every channel at ${formatCount(p.closeAt)} or fewer`,
		);
	if (shown("weight"))
		row(
			"Weight",
			editing === "weight" ? (
				<span className="flex items-center gap-1.5">
					<InlineInput
						initial={
							p.weightGrams
								? String(
										Math.round((p.weightGrams / GRAMS_PER_OUNCE) * 10) / 10,
									)
								: ""
						}
						label="Weight in ounces"
						parse={parsePositive}
						onSave={(weightOz) => editProduct(p, { weightOz }, "Weight")}
						onDone={done}
						className="w-20 text-right"
					/>
					<span className="text-muted-foreground">oz packed</span>
				</span>
			) : (
				<Value onEdit={() => setEditing("weight")}>
					{p.weightGrams && poundsOunces(p.weightGrams)}
				</Value>
			),
		);
	if (shown("box"))
		row(
			"Box",
			editing === "box" ? (
				<BoxInput
					box={box}
					onSave={(sides) =>
						editProduct(
							p,
							sides
								? { lengthIn: sides[0], widthIn: sides[1], heightIn: sides[2] }
								: { lengthIn: null, widthIn: null, heightIn: null },
							"Box",
						)
					}
					onDone={done}
				/>
			) : (
				<Value onEdit={() => setEditing("box")}>{box && formatBox(box)}</Value>
			),
		);

	return (
		<Card title="Product organization">
			{rows.length > 0 && (
				<dl className="mb-3 flex flex-col gap-2">
					{rows.map(([label, value]) => (
						<div key={label}>
							<dt className="text-muted-foreground">{label}</dt>
							<dd className="tabular-nums">{value}</dd>
						</div>
					))}
				</dl>
			)}
			{missing.length > 0 && (
				<p className="mb-3 flex flex-wrap gap-x-3 text-muted-foreground">
					{missing.map((k) => (
						<button
							key={k}
							type="button"
							onClick={() => setEditing(k)}
							className="text-link hover:underline"
						>
							+ {ADD_LABELS[k]}
						</button>
					))}
				</p>
			)}
			<div className="flex flex-col gap-2">
				<InsureToggle
					productId={p.id}
					sku={p.sku}
					insure={p.insureWhenShipped}
				/>
				<AerosolToggle productId={p.id} sku={p.sku} aerosol={p.aerosol} />
				<CriticalToggle
					productId={p.id}
					sku={p.sku}
					critical={p.critical}
					isA={d.abc?.abc === "A"}
				/>
			</div>
		</Card>
	);
}

// A saved value; clicking it types over it.
function Value({
	onEdit,
	children,
}: {
	onEdit: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onEdit}
			className="-mx-1 rounded px-1 text-left hover:bg-surface"
		>
			{children}
		</button>
	);
}

type Sides = [number, number, number];

// The box's three sides in inches, all or none: all three empty clears it.
// One missing or not over 0 shakes, with that side marked.
function BoxInput({
	box,
	onSave,
	onDone,
}: {
	box: Sides | null;
	onSave: (sides: Sides | null) => void;
	onDone: () => void;
}) {
	const form = useRef<HTMLFormElement>(null);
	const cancelled = useRef(false);
	const initial = box?.map((s) => String(inches(s))) ?? ["", "", ""];
	const [sides, setSides] = useState(initial);

	function commit() {
		if (cancelled.current || sides.every((s, i) => s.trim() === initial[i]))
			return onDone();
		if (sides.every((s) => s.trim() === "")) {
			onDone();
			return onSave(null);
		}
		const values = sides.map((s) => Number(s));
		const bad = values.map((v, i) => sides[i].trim() === "" || !(v > 0));
		if (bad.some(Boolean)) {
			for (const [i, el] of (
				form.current?.querySelectorAll("input") ?? []
			).entries())
				el.toggleAttribute("aria-invalid", bad[i]);
			return shake(form.current);
		}
		onDone();
		onSave(values as Sides);
	}

	return (
		<form
			ref={form}
			onSubmit={(e) => {
				e.preventDefault();
				commit();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					// Not the page's Escape, which goes back.
					e.preventDefault();
					cancelled.current = true;
					onDone();
				}
			}}
			// Leaving all three saves, as leaving one field does elsewhere.
			onBlur={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget)) commit();
			}}
			className="flex items-center gap-1"
		>
			{(["L", "W", "H"] as const).map((side, i) => (
				<span key={side} className="contents">
					{i > 0 && <span className="text-muted-foreground">×</span>}
					<input
						// biome-ignore lint/a11y/noAutofocus: opened by clicking the box
						autoFocus={i === 0}
						inputMode="decimal"
						aria-label={`${side} in`}
						placeholder={side}
						value={sides[i]}
						onChange={(e) => {
							const next = [...sides];
							next[i] = e.target.value;
							setSides(next);
							e.target.removeAttribute("aria-invalid");
						}}
						className={cn(
							fieldBox,
							"w-14 text-right aria-invalid:border-critical-border",
						)}
					/>
				</span>
			))}
			<span className="ml-1 text-muted-foreground">in</span>
			{/* Enter submits a form only when it has a submit button. */}
			<button type="submit" hidden />
		</form>
	);
}

// The product's name, typed over in place. It can't be empty.
export function NameField({ p }: { p: Product }) {
	const [editing, setEditing] = useState(false);
	return editing ? (
		<InlineInput
			initial={p.name}
			label="Name"
			parse={(t) => (t.trim() ? { value: t.trim() } : null)}
			onSave={(name) => editProduct(p, { name }, "Name")}
			onDone={() => setEditing(false)}
			className="h-8 text-base font-semibold"
		/>
	) : (
		<Value onEdit={() => setEditing(true)}>{p.name}</Value>
	);
}

// What sets the product apart in its group, typed over in place; empty
// clears it. Only a product in a group has one, so only those offer it.
export function VariantField({ p }: { p: Product }) {
	const [editing, setEditing] = useState(false);
	if (p.groupId === null)
		return (
			p.variantName && <p className="text-muted-foreground">{p.variantName}</p>
		);
	return editing ? (
		<InlineInput
			initial={p.variantName ?? ""}
			placeholder="e.g. 12 x 9 x 2"
			label="Variant name"
			parse={parseText}
			onSave={(variantName) => editProduct(p, { variantName }, "Variant name")}
			onDone={() => setEditing(false)}
			className="mt-1"
		/>
	) : (
		<p className="text-muted-foreground">
			<Value onEdit={() => setEditing(true)}>
				{p.variantName ?? <span className="text-link">+ Variant name</span>}
			</Value>
		</p>
	);
}
