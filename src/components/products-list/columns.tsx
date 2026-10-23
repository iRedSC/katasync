import {
	Boxes,
	ClipboardCheck,
	DollarSign,
	type LucideIcon,
	Store,
	Truck,
} from "lucide-react";
import type { ReactNode } from "react";
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
import { VelocityGauge } from "#/components/velocity-gauge";
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
	cell: (c: CellContext) => ReactNode;
};

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
		cell: ({ product }) => <ProductCell product={product} />,
	},
	class: {
		label: "Class",
		sort: "class",
		align: "center",
		tip: "A sells the most by value, C the least",
		cell: ({ product }) => <ClassCell product={product} />,
	},
	level: {
		label: "Status",
		sort: "level",
		from: "md",
		cell: ({ state }) => <LevelCell level={state.level} />,
	},
	stock: {
		label: "Stock",
		sort: "inventory",
		tip: "What can be sold or built. The bar runs to max; the tick is min",
		cell: ({ product }) => <StockCell product={product} />,
	},
	onhand: {
		label: "On hand",
		sort: "onhand",
		align: "right",
		cell: ({ product }) => <NumberCell n={product.onHand} />,
	},
	range: {
		label: "Keep",
		sort: "min",
		align: "right",
		from: "xl",
		tip: "Min to max stock",
		cell: ({ product }) => <RangeCell product={product} />,
	},
	onorder: {
		label: "On order",
		sort: "onorder",
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
		align: "right",
		from: "md",
		tip: "Days on hand lasts at the recent rate",
		cell: ({ state }) => <RunsOutCell days={state.daysLeft} />,
	},
	next: {
		label: "Next step",
		sort: "step",
		cell: ({ product, state, busy, onAddToPo, onCount }) => (
			<StepCell
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
		firstDesc: true,
		cell: ({ product }) => <ReorderCell product={product} />,
	},
	ordercost: {
		label: "Order cost",
		sort: "ordercost",
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
		firstDesc: true,
		align: "right",
		cell: ({ product }) => <NumberCell n={product.unitCost} money />,
	},
	worth: {
		label: "Stock worth",
		sort: "worth",
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
		tip: "Whether a recent count backs the number",
		cell: ({ state, now }) => <TrustCell trust={state.trust} now={now} />,
	},
	counted: {
		label: "Last counted",
		sort: "counted",
		from: "md",
		cell: ({ product, now }) => (
			<CountedCell at={product.lastCountedAt} now={now} />
		),
	},
	supplier: {
		label: "Supplier",
		sort: "supplier",
		from: "2xl",
		cell: ({ product }) =>
			product.supplier ? (
				<span className="whitespace-nowrap">{product.supplier.name}</span>
			) : (
				<span className="text-faint">None</span>
			),
	},
	type: {
		label: "Type",
		sort: "type",
		cell: ({ product }) => product.category,
	},
	vendor: {
		label: "Vendor",
		sort: "vendor",
		from: "md",
		cell: ({ product }) => product.vendor,
	},
	tags: {
		label: "Tags",
		sort: "tags",
		from: "xl",
		cell: ({ product }) => <TagsCell tags={product.tags} />,
	},
	listing: {
		label: "Shopify",
		sort: "listing",
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
		columns: ["type", "vendor", "tags", "listing", "supplier"],
	},
} as const satisfies Record<string, Lens>;
export type LensKey = keyof typeof LENSES;

export const isLens = (key: unknown): key is LensKey =>
	typeof key === "string" && Object.hasOwn(LENSES, key);
