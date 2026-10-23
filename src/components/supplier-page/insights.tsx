import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Badge, Card } from "#/components/page";
import { ProductImage } from "#/components/product";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatDay, formatMoney } from "#/lib/format";
import { useRowLink } from "#/lib/row-link";
import { cn } from "#/lib/utils";
import { MIN_MEASURED_POS } from "#/purchasing/forecast";
import type { SupplierDetail } from "#/server/purchasing";

// What a supplier's page shows about buying from it: totals, spend by month,
// its POs, and its products by what we buy and what sells.

const money = (cents: number) => formatMoney(cents / 100);

export function StatTiles({ d }: { d: SupplierDetail }) {
	const { year, all } = d.spend;
	const lead = d.leadTime;
	return (
		<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
			<Tile
				label="Spent, past year"
				value={money(year.cents)}
				sub={`${money(all.cents)} all time`}
				tip={
					year.unpriced > 0
						? `${formatCount(year.unpriced)} unpriced lines left out`
						: "Sent POs, after discounts"
				}
			/>
			<Tile
				label="Units bought, past year"
				value={formatCount(year.units)}
				sub={`${formatCount(all.units)} all time`}
			/>
			<Tile
				label="POs sent, past year"
				value={formatCount(year.pos)}
				sub={
					year.pos > 0
						? `${money(year.cents / year.pos)} average`
						: `${formatCount(all.pos)} all time`
				}
			/>
			<Tile
				label="Lead time"
				value={`${lead.days} days`}
				sub={
					lead.measured
						? lead.measured.days === lead.configured
							? `Measured, as typed`
							: `Measured; typed ${lead.configured}`
						: `Typed; measured after ${MIN_MEASURED_POS} POs`
				}
				tone={
					lead.measured && lead.measured.days > lead.configured
						? "warning"
						: undefined
				}
				tip={
					lead.measured
						? `The median of the last ${lead.measured.pos} received POs`
						: undefined
				}
			/>
		</div>
	);
}

function Tile({
	label,
	value,
	sub,
	tip,
	tone,
}: {
	label: string;
	value: string;
	sub: string;
	tip?: string;
	tone?: "warning";
}) {
	return (
		<Tip content={tip}>
			<div className="flex flex-col gap-0.5 rounded-xl bg-card p-4 shadow-card">
				<span className="text-xs text-muted-foreground">{label}</span>
				<span className="text-xl font-semibold tracking-tight tabular-nums">
					{value}
				</span>
				<span
					className={cn(
						"text-xs text-muted-foreground tabular-nums",
						tone === "warning" && "text-warning-text",
					)}
				>
					{sub}
				</span>
			</div>
		</Tip>
	);
}

// Spend per month for the past year as bars, this month last. Each bar
// gives its amount on hover.
export function MonthlySpend({ d }: { d: SupplierDetail }) {
	const top = Math.max(...d.monthly.map((m) => m.cents), 1);
	const total = d.monthly.reduce((n, m) => n + m.cents, 0);
	return (
		<Card title="Spend by month" aside={money(total)}>
			{total === 0 ? (
				<p className="text-muted-foreground">Nothing sent in the past year.</p>
			) : (
				<div className="flex h-32 items-end gap-1.5">
					{d.monthly.map((m, i) => (
						<Tip key={m.key} content={`${m.label}: ${money(m.cents)}`}>
							<div className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
								<div
									className={cn(
										"w-full rounded-t-sm transition-colors",
										m.cents > 0
											? "bg-primary/70 hover:bg-primary"
											: "bg-surface-strong",
										i === d.monthly.length - 1 && m.cents > 0 && "bg-primary",
									)}
									style={{
										height: m.cents > 0 ? `${(m.cents / top) * 100}%` : 2,
									}}
								/>
								<span className="text-[10px] text-muted-foreground">
									{m.label[0]}
								</span>
							</div>
						</Tip>
					))}
				</div>
			)}
		</Card>
	);
}

type Po = SupplierDetail["open"][number];

// POs as rows that open them: number, status, the date that matters, total.
export function PoList({
	title,
	pos,
	empty,
}: {
	title: string;
	pos: Po[];
	empty: string;
}) {
	return (
		<Card flush title={title}>
			{pos.length === 0 ? (
				<p className="px-4 pb-4 text-muted-foreground">{empty}</p>
			) : (
				<table className="w-full">
					<tbody>
						{pos.map((po) => (
							<PoRow key={po.id} po={po} />
						))}
					</tbody>
				</table>
			)}
		</Card>
	);
}

function PoRow({ po }: { po: Po }) {
	const { link } = useRowLink();
	const when =
		po.status === "draft"
			? `Started ${formatDay(po.createdAt)}`
			: po.status === "sent"
				? po.expectedAt
					? `Due ${formatDay(po.expectedAt)}`
					: po.sentAt && `Sent ${formatDay(po.sentAt)}`
				: po.closedAt && `Closed ${formatDay(po.closedAt)}`;
	return (
		<tr
			{...link({ to: "/purchasing/$id", params: { id: String(po.id) } })}
			className="cursor-pointer border-t hover:bg-subtle"
		>
			<td className="px-4 py-2 font-medium whitespace-nowrap">
				<Link
					to="/purchasing/$id"
					params={{ id: String(po.id) }}
					className="hover:underline"
				>
					PO {po.id}
				</Link>
			</td>
			<td className="px-2 py-2">
				<Badge tone={po.shows.tone}>{po.shows.label}</Badge>
			</td>
			<td className="w-full px-2 py-2 text-muted-foreground">{when}</td>
			<td className="px-2 py-2 text-right whitespace-nowrap text-muted-foreground tabular-nums">
				{formatCount(po.lines)} {po.lines === 1 ? "line" : "lines"}
			</td>
			<td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">
				{money(po.cents)}
			</td>
		</tr>
	);
}

// The products bought most from it over the past year, by units or spend.
export function TopBought({ d }: { d: SupplierDetail }) {
	const [by, setBy] = useState<"units" | "cents">("units");
	const list = by === "units" ? d.topByUnits : d.topByCents;
	return (
		<Card
			flush
			title="Bought most, past year"
			aside={
				<div className="flex rounded-lg bg-subtle p-0.5 text-xs">
					{(["units", "cents"] as const).map((k) => (
						<button
							key={k}
							type="button"
							aria-pressed={by === k}
							onClick={() => setBy(k)}
							className={cn(
								"rounded-md px-2 py-0.5 text-muted-foreground",
								by === k && "bg-white text-foreground shadow-sm",
							)}
						>
							{k === "units" ? "Units" : "Spend"}
						</button>
					))}
				</div>
			}
		>
			<ProductList
				empty="Nothing bought in the past year."
				rows={list.map((p) => ({
					product: p.product,
					value: by === "units" ? formatCount(p.units) : money(p.cents),
					sub:
						by === "units" ? money(p.cents) : `${formatCount(p.units)} units`,
					share: p[by] / Math.max(list[0]?.[by] ?? 1, 1),
				}))}
			/>
		</Card>
	);
}

// Its products that sell most lately, and whether reorder buys them here.
export function TopSelling({ d }: { d: SupplierDetail }) {
	const top = d.topSelling[0]?.units ?? 1;
	return (
		<Card flush title={`Sells most, last ${d.sellingDays} days`}>
			<ProductList
				empty="None of what it sells has sold lately."
				rows={d.topSelling.map((p) => ({
					product: p.product,
					value: `${formatCount(p.units)} sold`,
					sub: p.cheapest ? undefined : "Bought elsewhere",
					subTip: p.cheapest
						? undefined
						: "Another supplier sells it for less, so reorder buys it there",
					share: p.units / top,
				}))}
			/>
		</Card>
	);
}

type Named = SupplierDetail["topByUnits"][number]["product"];

function ProductList({
	rows,
	empty,
}: {
	rows: {
		product: Named;
		value: string;
		sub?: string;
		subTip?: string;
		share: number;
	}[];
	empty: string;
}) {
	if (rows.length === 0)
		return <p className="px-4 pb-4 text-muted-foreground">{empty}</p>;
	return (
		<ul className="flex flex-col pb-2">
			{rows.map((r) => (
				<ProductRow key={r.product.id} {...r} />
			))}
		</ul>
	);
}

function ProductRow({
	product: p,
	value,
	sub,
	subTip,
	share,
}: {
	product: Named;
	value: string;
	sub?: string;
	subTip?: string;
	share: number;
}) {
	return (
		<li>
			<Link
				to="/products/$sku"
				params={{ sku: p.sku }}
				className="relative flex items-center gap-3 px-4 py-1.5 hover:bg-subtle"
			>
				{/* How it compares with the top one, behind the row. */}
				<span
					aria-hidden
					className="absolute inset-y-1 left-0 rounded-r-md bg-primary/5"
					style={{ width: `${Math.max(share, 0.02) * 100}%` }}
				/>
				<ProductImage src={p.imageUrl} className="relative size-8" />
				<span className="relative min-w-0 flex-1">
					<span className="block truncate font-medium">
						{p.variantName ? `${p.name} ${p.variantName}` : p.name}
					</span>
					<span className="block text-xs text-muted-foreground">{p.sku}</span>
				</span>
				<span className="relative flex flex-col items-end tabular-nums">
					<span className="font-medium whitespace-nowrap">{value}</span>
					{sub && <Sub tip={subTip}>{sub}</Sub>}
				</span>
			</Link>
		</li>
	);
}

function Sub({ tip, children }: { tip?: string; children: ReactNode }) {
	return (
		<Tip content={tip}>
			<span
				className={cn(
					"text-xs whitespace-nowrap text-muted-foreground",
					tip && "text-warning-text",
				)}
			>
				{children}
			</span>
		</Tip>
	);
}
