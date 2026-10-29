import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { formatMoney, formatPhone } from "#/lib/format";
import type { InvoiceGroup, RepairInvoice } from "#/repairs/invoice";
import { formatMinutes } from "#/repairs/labor";
import { getRepairInvoice } from "#/server/repairs";

// A repair's letter-size invoice (src/repairs/invoice.ts): each tool with
// its labor and parts and what it comes to, then what's for the order as a
// whole, then the totals, all at Shopify's prices. Opens the print dialog
// on its own once priced; without prices it says why and waits.
export const Route = createFileRoute("/print/repairs/$id")({
	loader: ({ params }) => getRepairInvoice({ data: { id: Number(params.id) } }),
	head: ({ params }) => ({ meta: [{ title: `R${params.id} invoice` }] }),
	component: Invoice,
});

const date = (d: Date | string) =>
	new Date(d).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: "America/New_York",
	});

function Invoice() {
	const inv = Route.useLoaderData();
	const r = inv.repair;
	const priced = inv.unpriced === null;
	useEffect(() => {
		if (priced) window.print();
	}, [priced]);

	return (
		<div className="min-h-svh bg-surface py-6 print:bg-white print:py-0">
			<style>{"@page { size: letter; margin: 0.5in; }"}</style>
			<div className="mx-auto mb-4 flex max-w-[8.5in] items-center justify-between gap-4 print:hidden">
				{inv.unpriced ? (
					<span className="text-critical-text">No prices: {inv.unpriced}</span>
				) : (
					<span />
				)}
				<button
					type="button"
					onClick={() => window.print()}
					className="h-8 rounded-lg bg-primary px-3 font-semibold text-white hover:bg-primary-hover"
				>
					Print
				</button>
			</div>
			<article className="mx-auto flex min-h-[11in] max-w-[8.5in] flex-col gap-6 bg-white p-[0.5in] text-[10.5pt] text-black shadow-card print:m-0 print:min-h-[9.95in] print:max-w-none print:p-0 print:shadow-none">
				<header className="flex items-start justify-between gap-6">
					<div>
						<p className="text-[14pt] font-bold">{inv.from?.name}</p>
						{inv.from?.lines.map((l) => (
							<p key={l}>{l}</p>
						))}
						{inv.from?.phone && <p>{formatPhone(inv.from.phone)}</p>}
						{inv.from?.email && <p>{inv.from.email}</p>}
					</div>
					<div className="text-right">
						<p className="text-[20pt] font-bold">Repair Invoice</p>
						<p className="font-semibold">R{r.id}</p>
						{inv.bill && <p>{inv.bill.name}</p>}
						<p>{date(new Date())}</p>
						<p className="text-muted-foreground">
							Received {date(r.createdAt)}
						</p>
					</div>
				</header>

				<section>
					<p className="text-[9pt] font-semibold tracking-wide text-muted-foreground uppercase">
						Customer
					</p>
					<p className="text-[13pt] font-semibold">{r.customerName}</p>
					{r.customerPhone && <p>{formatPhone(r.customerPhone)}</p>}
					{r.customerEmail && <p>{r.customerEmail}</p>}
				</section>

				{inv.groups.map((g, i) => (
					<Group
						key={g.tool?.id ?? "other"}
						group={g}
						place={
							g.tool && inv.groups.filter((x) => x.tool).length > 1
								? i + 1
								: null
						}
					/>
				))}

				{inv.added.length > 0 && (
					<section className="break-inside-avoid">
						<h2 className="border-b-2 border-black pb-1 text-[12pt] font-bold">
							Also purchased
						</h2>
						<table className="w-full table-fixed border-collapse">
							<colgroup>
								<col className="w-16" />
								<col />
								<col className="w-24" />
							</colgroup>
							<tbody>
								{inv.added.map((l, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: lines print in a fixed order
									<tr key={i} className="border-b border-border">
										<td className="py-1.5 font-bold tabular-nums">
											{l.quantity}
										</td>
										<td className="py-1.5">{l.title}</td>
										<td className="py-1.5 text-right tabular-nums">
											{formatMoney(l.total)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
				)}

				{inv.bill && <Totals bill={inv.bill} adjustment={inv.adjustment} />}

				<footer className="mt-auto text-muted-foreground">
					Thank you for your business.
				</footer>
			</article>
		</div>
	);
}

function Group({
	group: g,
	place,
}: {
	group: InvoiceGroup;
	// Its number among several tools, matching their tickets.
	place: number | null;
}) {
	const empty =
		g.labor.length === 0 && g.parts.length === 0 && g.extra.length === 0;
	return (
		<section className="break-inside-avoid">
			<div className="flex items-baseline justify-between gap-4 border-b-2 border-black pb-1">
				<h2 className="text-[12pt] font-bold">
					{place !== null && `${place}. `}
					{g.tool?.tool ?? "Other charges"}
					{g.tool?.serial && (
						<span className="ml-2 text-[9pt] font-normal text-muted-foreground">
							Serial {g.tool.serial}
						</span>
					)}
				</h2>
				{g.subtotal !== null && (
					<span className="font-bold tabular-nums">
						{formatMoney(g.subtotal)}
					</span>
				)}
			</div>
			{g.tool?.problem && (
				<p className="mt-1 text-[9.5pt] text-muted-foreground">
					{g.tool.problem}
				</p>
			)}
			{empty ? (
				<p className="py-1.5 text-muted-foreground">No charge</p>
			) : (
				<table className="w-full table-fixed border-collapse">
					<colgroup>
						<col className="w-16" />
						<col />
						<col className="w-24" />
						<col className="w-24" />
					</colgroup>
					<tbody>
						{g.labor.length > 0 && (
							<tr className="border-b border-border align-top">
								<td className="py-1.5 font-bold whitespace-nowrap tabular-nums">
									{formatMinutes(g.laborMinutes)}
								</td>
								<td className="py-1.5">
									<p>Labor</p>
									{g.labor.some((l) => l.note) && (
										<ul className="mt-0.5 text-[9.5pt] text-muted-foreground">
											{g.labor.map((l, i) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: entries print in a fixed order
												<li key={i}>
													<span className="inline-block w-12 tabular-nums">
														{formatMinutes(l.minutes)}
													</span>
													{l.note}
												</li>
											))}
										</ul>
									)}
								</td>
								<td className="py-1.5" />
								<td className="py-1.5 text-right tabular-nums">
									{g.laborTotal !== null && formatMoney(g.laborTotal)}
								</td>
							</tr>
						)}
						{g.extra.map((l, i) => (
							<tr
								// biome-ignore lint/suspicious/noArrayIndexKey: lines print in a fixed order
								key={`extra-${i}`}
								className="border-b border-border align-top"
							>
								<td className="py-1.5 font-bold tabular-nums">{l.quantity}</td>
								<td className="py-1.5">{l.title}</td>
								<td className="py-1.5" />
								<td className="py-1.5 text-right tabular-nums">
									{formatMoney(l.total)}
								</td>
							</tr>
						))}
						{g.parts.map((p) => (
							<tr key={p.sku} className="border-b border-border align-top">
								<td className="py-1.5 font-bold tabular-nums">{p.quantity}</td>
								<td className="py-1.5">
									<p>
										{p.variantName ? `${p.name}, ${p.variantName}` : p.name}
									</p>
									<p className="text-[9pt] text-muted-foreground">{p.sku}</p>
								</td>
								<td className="py-1.5 text-right tabular-nums text-muted-foreground">
									{p.total !== null &&
										p.quantity > 1 &&
										`${formatMoney(p.total / p.quantity)} ea`}
								</td>
								<td className="py-1.5 text-right tabular-nums">
									{p.total !== null && formatMoney(p.total)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}

function Totals({
	bill,
	adjustment,
}: {
	bill: NonNullable<RepairInvoice["bill"]>;
	adjustment: number;
}) {
	return (
		<dl className="ml-auto grid w-64 grid-cols-[1fr_auto] gap-y-1 tabular-nums break-inside-avoid [&_dd]:pl-6">
			{Math.abs(adjustment) >= 0.01 && (
				<>
					<dt>{adjustment < 0 ? "Discount" : "Adjustment"}</dt>
					<dd className="text-right">{formatMoney(adjustment)}</dd>
				</>
			)}
			<dt>Subtotal</dt>
			<dd className="text-right">{formatMoney(bill.subtotal)}</dd>
			{bill.shipping > 0 && (
				<>
					<dt>Shipping</dt>
					<dd className="text-right">{formatMoney(bill.shipping)}</dd>
				</>
			)}
			<dt>Tax</dt>
			<dd className="text-right">{formatMoney(bill.tax)}</dd>
			<dt className="border-t-2 border-black pt-1 font-bold">Total</dt>
			<dd className="border-t-2 border-black pt-1 text-right font-bold">
				{formatMoney(bill.total)}
			</dd>
			{bill.ordered && (
				<>
					<dt>Paid</dt>
					<dd className="text-right">{formatMoney(bill.total - bill.due)}</dd>
				</>
			)}
			{bill.refunded > 0 && (
				<>
					<dt>Refunded</dt>
					<dd className="text-right">{formatMoney(bill.refunded)}</dd>
				</>
			)}
			<dt className="font-bold">Balance due</dt>
			<dd className="text-right font-bold">{formatMoney(bill.due)}</dd>
		</dl>
	);
}
