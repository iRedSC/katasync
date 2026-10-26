import { Plus, Tags, X } from "lucide-react";
import { Popover } from "radix-ui";
import { type FormEvent, useRef, useState } from "react";
import { patchCatalog } from "#/components/catalogs/data";
import { shake } from "#/components/shake";
import { formatCount, formatMoney } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { breaksProblem, type PriceBreak } from "#/purchasing/bulk";
import { setBulkPrices } from "#/server/purchasing";

type Offer = {
	supplierId: number;
	cost: number | null;
	unit: string;
	minimumQuantity: number;
	breaks: PriceBreak[];
};

// A supplier's bulk prices for a product, in its cell of a catalog's price
// table: listed under the price, or Add bulk price while the row is hovered.
// Either opens them to edit.
export function BulkPrices({
	catalogId,
	productId,
	label,
	offer: o,
}: {
	catalogId: number;
	productId: number;
	label: string;
	offer: Offer;
}) {
	const [open, setOpen] = useState(false);
	const has = o.breaks.length > 0;
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				aria-label={`Bulk prices for ${label}`}
				className={cn(
					"inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs tabular-nums outline-offset-2 hover:bg-surface focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring",
					has
						? "text-muted-foreground"
						: "text-faint opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100",
				)}
			>
				<Tags className="size-3 shrink-0" aria-hidden />
				{has
					? o.breaks
							.map(
								(b) => `${formatCount(b.minQuantity)}+ ${formatMoney(b.cost)}`,
							)
							.join(" · ")
					: "Add bulk price"}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					collisionPadding={12}
					// The row behind opens the product.
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
					className="z-50 w-72 rounded-xl bg-white p-3 shadow-[0_4px_16px_rgba(0,0,0,0.16),0_0_0_1px_rgba(0,0,0,0.06)]"
				>
					<BreaksForm
						catalogId={catalogId}
						productId={productId}
						label={label}
						offer={o}
						onDone={() => setOpen(false)}
					/>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

type Row = { key: number; minQuantity: string; cost: string };

const input =
	"h-8 w-full rounded-lg border border-input bg-white px-2 text-right tabular-nums outline-none focus:border-ring";

function BreaksForm({
	catalogId,
	productId,
	label,
	offer: o,
	onDone,
}: {
	catalogId: number;
	productId: number;
	label: string;
	offer: Offer;
	onDone: () => void;
}) {
	const next = useRef(0);
	const row = (b?: PriceBreak): Row => ({
		key: next.current++,
		minQuantity: b ? String(b.minQuantity) : "",
		cost: b ? String(b.cost) : "",
	});
	const [rows, setRows] = useState<Row[]>(() =>
		o.breaks.length > 0 ? o.breaks.map(row) : [row()],
	);
	const [problem, setProblem] = useState<string | null>(null);
	const form = useRef<HTMLFormElement>(null);

	const edit = (key: number, change: Partial<Row>) => {
		setProblem(null);
		setRows((all) => all.map((r) => (r.key === key ? { ...r, ...change } : r)));
	};

	// Blank rows are left out; half-filled ones aren't a price yet.
	function parse(): PriceBreak[] | string {
		const filled = rows.filter(
			(r) => r.minQuantity.trim() !== "" || r.cost.trim() !== "",
		);
		if (filled.some((r) => r.minQuantity.trim() === "" || r.cost.trim() === ""))
			return "Give each a quantity and a price";
		const breaks = filled.map((r) => ({
			minQuantity: Number(r.minQuantity.trim()),
			cost: Number(r.cost.trim().replace(/^\$/, "")),
		}));
		return breaksProblem(o.cost, o.minimumQuantity, breaks) ?? breaks;
	}

	async function submit(e: FormEvent) {
		e.preventDefault();
		const breaks = parse();
		if (typeof breaks === "string") {
			setProblem(breaks);
			shake(form.current);
			return;
		}
		onDone();
		const sorted = [...breaks].sort((a, b) => a.minQuantity - b.minQuantity);
		const r = await save(catalogId, productId, o.supplierId, label, sorted);
		if (!r) return;
		offerUndo(
			sorted.length === 0
				? `No bulk prices for ${label}`
				: `Saved bulk prices for ${label}`,
			{
				undo: async () =>
					(await save(catalogId, productId, o.supplierId, label, r.value)) &&
					`Put back bulk prices for ${label}`,
			},
		);
	}

	return (
		<form ref={form} onSubmit={submit} className="flex flex-col gap-2">
			<div className="grid grid-cols-[1fr_1fr_1.75rem] items-center gap-x-2 gap-y-1.5">
				<span className="text-xs text-muted-foreground">From ({o.unit})</span>
				<span className="text-right text-xs text-muted-foreground">Each</span>
				<span />
				<span className="px-2 text-right text-sm text-muted-foreground tabular-nums">
					{formatCount(Math.max(1, o.minimumQuantity))}
				</span>
				<span className="px-2 text-right text-sm text-muted-foreground tabular-nums">
					{formatMoney(o.cost)}
				</span>
				<span />
				{rows.map((r, i) => (
					<BreakRow
						key={r.key}
						row={r}
						// A new row is for typing into straight away.
						autoFocus={i === rows.length - 1 && r.minQuantity === ""}
						onChange={(change) => edit(r.key, change)}
						onRemove={() => {
							setProblem(null);
							setRows((all) => all.filter((x) => x.key !== r.key));
						}}
					/>
				))}
			</div>
			{problem && <p className="text-xs text-critical-text">{problem}</p>}
			<div className="flex items-center justify-between gap-2 pt-1">
				<button
					type="button"
					onClick={() => setRows((all) => [...all, row()])}
					className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-surface hover:text-foreground"
				>
					<Plus className="size-3.5" aria-hidden />
					Add
				</button>
				<button
					type="submit"
					className="h-8 cursor-pointer rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
				>
					Save
				</button>
			</div>
		</form>
	);
}

function BreakRow({
	row: r,
	autoFocus,
	onChange,
	onRemove,
}: {
	row: Row;
	autoFocus: boolean;
	onChange: (change: Partial<Row>) => void;
	onRemove: () => void;
}) {
	return (
		<>
			<input
				aria-label="From how many"
				inputMode="numeric"
				// biome-ignore lint/a11y/noAutofocus: the row was just added to type into
				autoFocus={autoFocus}
				value={r.minQuantity}
				onChange={(e) => onChange({ minQuantity: e.target.value })}
				className={input}
			/>
			<input
				aria-label="Price each"
				inputMode="decimal"
				value={r.cost}
				onChange={(e) => onChange({ cost: e.target.value })}
				className={input}
			/>
			<button
				type="button"
				aria-label="Remove this bulk price"
				onClick={onRemove}
				className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-critical-text"
			>
				<X className="size-3.5" />
			</button>
		</>
	);
}

// Saves them, shown on the table at once.
function save(
	catalogId: number,
	productId: number,
	supplierId: number,
	label: string,
	breaks: PriceBreak[],
) {
	return optimism.change({
		label: `Bulk prices for ${label}`,
		patch: patchCatalog(catalogId, (d) => ({
			...d,
			products: d.products.map((x) =>
				x.id !== productId
					? x
					: {
							...x,
							offers: x.offers.map((y) =>
								y.supplierId !== supplierId ? y : { ...y, breaks },
							),
						},
			),
		})),
		send: () => setBulkPrices({ data: { productId, supplierId, breaks } }),
	});
}
