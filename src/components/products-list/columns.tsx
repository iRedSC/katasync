import {
	Boxes,
	ClipboardCheck,
	DollarSign,
	type LucideIcon,
	Store,
	Truck,
} from "lucide-react";
import type { ReactNode } from "react";
import { CatalogMark } from "#/components/catalog-mark";
import {
	ClassCell,
	CountedCell,
	LevelCell,
	ListingCell,
	NumberCell,
	ProductCell,
	RangeCell,
	ReorderCell,
	RunsOutCell,
	StepCell,
	StockCell,
	TagsCell,
	TrustCell,
} from "#/components/products-list/cells";
import { Tip } from "#/components/ui/tooltip";
import { VelocityGauge } from "#/components/velocity-gauge";
import { cn } from "#/lib/utils";
import { orderCost, type StockState, stock } from "#/products/rows";
import type { ProductSortKey } from "#/products/views";
import type { ProductRow } from "#/server/catalog";

// What a cell gets to draw from, and the row actions its buttons run.
export type CellContext = {
	product: ProductRow;
	state: StockState;
	now: Date;
	busy: boolean;
	onAddToPo: (p: ProductRow) => void;
	onCount: (p: ProductRow) => void;
};

export type Column = {
	label: string;
	// What clicking the header sorts by. Required, so every column sorts.
	sort: ProductSortKey;
	// Which way a first click sorts. Money and speed lead with the most.
	firstDesc?: boolean;
	align?: "right" | "center";
	// Explains a header whose label alone doesn't.
	tip?: string;
	// Hidden below this width, so the product's name keeps its room.
	from?: "md" | "lg" | "xl" | "2xl";
	// The header's width, wide enough for any row's cell, so sorting a
	// different page of rows in doesn't shift the columns. Text that could run
	// longer is cut to fit. On the header's button, since a table cell's own
	// width gives way to the product column's.
	width: string;
	cell: (c: CellContext) => ReactNode;
};

// Text cut to its column's width, whole in the tooltip.
function Cut({
	children,
	className,
}: {
	children: string | null;
	className?: string;
}) {
	return (
		<Tip content={children}>
			<span className={cn("block truncate", className)}>{children}</span>
		</Tip>
	);
}

export const FROM_CLASS = {
	md: "hidden md:table-cell",
	lg: "hidden lg:table-cell",
	xl: "hidden xl:table-cell",
	"2xl": "hidden 2xl:table-cell",
} as const;

const COLUMN_DEFS = {
	product: {
		label: "Product",
		sort: "name",
		width: "w-full",
		cell: ({ product }) => <ProductCell product={product} />,
	},
	class: {
		label: "Class",
		sort: "class",
		width: "w-16",
		align: "center",
		tip: "A sells the most by value, C the least",
		cell: ({ product }) => <ClassCell product={product} />,
	},
	level: {
		label: "Status",
		sort: "level",
		width: "w-26",
		from: "md",
		cell: ({ state }) => <LevelCell level={state.level} />,
	},
	stock: {
		label: "Stock",
		sort: "inventory",
		width: "w-24",
		tip: "What can be sold or built. The bar runs to max; the tick is min",
		cell: ({ product }) => <StockCell product={product} />,
	},
	onhand: {
		label: "On hand",
		sort: "onhand",
		width: "w-22",
		align: "right",
		cell: ({ product }) => <NumberCell n={product.onHand} />,
	},
	range: {
		label: "Keep",
		sort: "min",
		width: "w-22",
		align: "right",
		from: "xl",
		tip: "Min to max stock",
		cell: ({ product }) => <RangeCell product={product} />,
	},
	onorder: {
		label: "On order",
		sort: "onorder",
		width: "w-22",
		firstDesc: true,
		align: "right",
		from: "xl",
		tip: "Units on sent POs that haven't arrived",
		cell: ({ product }) =>
			product.onOrder > 0 ? <NumberCell n={product.onOrder} /> : null,
	},
	velocity: {
		label: "Sold/mo",
		sort: "velocity",
		width: "w-20",
		firstDesc: true,
		align: "center",
		from: "md",
		tip: "Units sold a month. Hover a ring for why reorder wants what it does",
		cell: ({ product }) => (
			<VelocityGauge why={product.why} onPo={product.draft ?? undefined} />
		),
	},
	runout: {
		label: "Runs out",
		sort: "runout",
		width: "w-22",
		align: "right",
		from: "md",
		tip: "Days on hand lasts at the recent rate",
		cell: ({ state }) => <RunsOutCell days={state.daysLeft} />,
	},
	next: {
		label: "Next step",
		sort: "step",
		width: "w-36",
		cell: ({ product, state, busy, onAddToPo, onCount }) => (
			<StepCell
				product={product}
				step={state.step}
				busy={busy}
				onOrder={() => onAddToPo(product)}
				onCount={() => onCount(product)}
			/>
		),
	},
	reorder: {
		label: "Reorder",
		sort: "reorder",
		width: "w-50",
		firstDesc: true,
		cell: ({ product }) => <ReorderCell product={product} />,
	},
	ordercost: {
		label: "Order cost",
		sort: "ordercost",
		width: "w-22",
		firstDesc: true,
		align: "right",
		from: "lg",
		tip: "The suggested order at the product's cost",
		cell: ({ product }) => {
			const cost = orderCost(product);
			return cost === null ? null : <NumberCell n={cost} money />;
		},
	},
	cost: {
		label: "Cost",
		sort: "cost",
		width: "w-18",
		firstDesc: true,
		align: "right",
		cell: ({ product }) => <NumberCell n={product.unitCost} money />,
	},
	worth: {
		label: "Stock worth",
		sort: "worth",
		width: "w-26",
		firstDesc: true,
		align: "right",
		tip: "On hand at cost",
		cell: ({ product: p }) => (
			<NumberCell
				n={
					p.unitCost === null || p.notCounted
						? null
						: Math.max(0, stock(p)) * p.unitCost
				}
				money
			/>
		),
	},
	trust: {
		label: "Trust",
		sort: "trust",
		width: "w-38",
		tip: "Whether a recent count backs the number",
		cell: ({ state, now }) => <TrustCell trust={state.trust} now={now} />,
	},
	counted: {
		label: "Last counted",
		sort: "counted",
		width: "w-26",
		from: "md",
		cell: ({ product, now }) => (
			<CountedCell at={product.lastCountedAt} now={now} />
		),
	},
	supplier: {
		label: "Primary Supplier",
		sort: "supplier",
		width: "w-40",
		from: "2xl",
		tip: "Who reorder buys it from: the cheapest supplier carrying its catalog",
		cell: ({ product }) =>
			product.supplier ? (
				<Cut className="max-w-40">{product.supplier.name}</Cut>
			) : (
				<span className="text-faint">None</span>
			),
	},
	catalog: {
		label: "Catalog",
		sort: "catalog",
		width: "w-46",
		tip: "The line it's sold in; every supplier carrying it sells it",
		cell: ({ product }) =>
			product.catalog ? (
				<span className="flex max-w-46 items-center gap-1.5">
					<CatalogMark catalog={product.catalog} size="xs" />
					<Cut>{product.catalog.name}</Cut>
				</span>
			) : (
				<span className="text-faint">None</span>
			),
	},
	type: {
		label: "Type",
		sort: "type",
		width: "w-38",
		cell: ({ product }) => <Cut className="max-w-38">{product.category}</Cut>,
	},
	vendor: {
		label: "Vendor",
		sort: "vendor",
		width: "w-38",
		from: "md",
		cell: ({ product }) => <Cut className="max-w-38">{product.vendor}</Cut>,
	},
	tags: {
		label: "Tags",
		sort: "tags",
		width: "w-64",
		from: "2xl",
		cell: ({ product }) => <TagsCell tags={product.tags} />,
	},
	listing: {
		label: "Shopify",
		sort: "listing",
		width: "w-22",
		cell: ({ product }) => <ListingCell status={product.status} />,
	},
} as const satisfies Record<string, Column>;
export type ColumnKey = keyof typeof COLUMN_DEFS;
export const COLUMNS: Record<ColumnKey, Column> = COLUMN_DEFS;

type Lens = {
	label: string;
	icon: LucideIcon;
	// After the product, which every lens leads with.
	columns: readonly Exclude<ColumnKey, "product">[];
};

// Ways to look at the same products, each with the columns for one job.
export const LENSES = {
	stock: {
		label: "Stock",
		icon: Boxes,
		columns: [
			"class",
			"level",
			"stock",
			"onorder",
			"velocity",
			"runout",
			"next",
			"supplier",
		],
	},
	reorder: {
		label: "Reorder",
		icon: Truck,
		columns: [
			"supplier",
			"stock",
			"range",
			"onorder",
			"velocity",
			"runout",
			"reorder",
			"ordercost",
		],
	},
	counts: {
		label: "Counts",
		icon: ClipboardCheck,
		columns: ["class", "trust", "counted", "onhand", "worth", "next"],
	},
	value: {
		label: "Value",
		icon: DollarSign,
		columns: ["class", "cost", "onhand", "worth", "velocity", "ordercost"],
	},
	catalog: {
		label: "Catalog",
		icon: Store,
		columns: ["catalog", "type", "vendor", "tags", "listing", "supplier"],
	},
} as const satisfies Record<string, Lens>;
export type LensKey = keyof typeof LENSES;

export const isLens = (key: unknown): key is LensKey =>
	typeof key === "string" && Object.hasOwn(LENSES, key);
