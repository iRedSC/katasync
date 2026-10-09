import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { cityLine, formatMoney } from "#/lib/format";
import { listInvoices } from "#/server/orders";

// One letter-size invoice per order still to ship, in pin order. Opens the
// print dialog on its own.
export const Route = createFileRoute("/print/invoices")({
	loader: () => listInvoices(),
	head: () => ({ meta: [{ title: "Invoices" }] }),
	component: Invoices,
});

const GRAMS_PER_OUNCE = 28.349523125;

type Data = Awaited<ReturnType<typeof listInvoices>>;

function Invoices() {
	const { from, invoices } = Route.useLoaderData();

	useEffect(() => {
		if (invoices.length > 0) window.print();
	}, [invoices.length]);

	return (
		<div className="min-h-svh bg-[#f1f1f1] py-6 print:bg-white print:py-0">
			<style>{"@page { size: letter; margin: 0.5in; }"}</style>
			<div className="mx-auto mb-4 flex max-w-[8.5in] items-center justify-between print:hidden">
				<span className="text-muted-foreground">
					{invoices.length} {invoices.length === 1 ? "invoice" : "invoices"}
				</span>
				<button
					type="button"
					onClick={() => window.print()}
					className="h-8 rounded-lg bg-[#303030] px-3 font-semibold text-white hover:bg-[#1a1a1a]"
				>
					Print
				</button>
			</div>
			{invoices.length === 0 && (
				<p className="text-center text-muted-foreground">Nothing to ship.</p>
			)}
			{invoices.map((invoice) => (
				<Invoice key={invoice.id} from={from} invoice={invoice} />
			))}
		</div>
	);
}

function Invoice({
	from,
	invoice: o,
}: {
	from: Data["from"];
	invoice: Data["invoices"][number];
}) {
	const subtotal = o.lines.reduce(
		(sum, l) => sum + l.unitPrice * l.quantity,
		0,
	);
	// Whatever the total holds beyond items and shipping: tax, or a discount
	// when negative.
	const rest = o.total - subtotal - o.shippingCharged;
	const shipTo = [
		o.shipAddress1,
		o.shipAddress2,
		cityLine(o.shipCity, o.shipRegion, o.shipPostalCode),
		o.shipCountry && o.shipCountry !== "US" ? o.shipCountry : null,
	].filter(Boolean);

	return (
		<article className="mx-auto mb-6 flex max-w-[8.5in] flex-col gap-8 bg-white p-[0.5in] text-[11pt] text-black shadow-card break-after-page last:break-after-auto print:m-0 print:max-w-none print:p-0 print:shadow-none">
			<header className="flex items-start justify-between gap-6">
				<div>
					<p className="text-[14pt] font-bold">{from?.name}</p>
					{from?.lines.map((l) => (
						<p key={l}>{l}</p>
					))}
					{from?.phone && <p>{formatPhone(from.phone)}</p>}
					{from?.email && <p>{from.email}</p>}
				</div>
				<div className="text-right">
					<p className="text-[20pt] font-bold">Invoice</p>
					<p className="font-semibold">{o.name}</p>
					{o.pin !== null && (
						<p className="font-semibold tabular-nums">
							{packLine(o.pin, o.boxPin, o.weightGrams)}
						</p>
					)}
					<p>
						{new Date(o.placedAt).toLocaleDateString("en-US", {
							month: "long",
							day: "numeric",
							year: "numeric",
						})}
					</p>
					{o.salesChannel && <p className="text-[#616161]">{o.salesChannel}</p>}
				</div>
			</header>

			<section>
				<p className="text-[9pt] font-semibold tracking-wide text-[#616161] uppercase">
					Ship to
				</p>
				<p className="text-[13pt] font-semibold">
					{o.customerName ?? "Customer"}
				</p>
				{shipTo.map((l) => (
					<p key={l}>{l}</p>
				))}
			</section>

			<table className="w-full border-collapse">
				<thead>
					<tr className="border-b-2 border-black text-left text-[9pt] tracking-wide uppercase">
						<th className="w-14 py-1.5 font-semibold">Qty</th>
						<th className="py-1.5 font-semibold">Item</th>
						<th className="w-24 py-1.5 text-right font-semibold">Price</th>
						<th className="w-24 py-1.5 text-right font-semibold">Total</th>
					</tr>
				</thead>
				<tbody>
					{o.lines.map((l, i) => (
						<tr
							// biome-ignore lint/suspicious/noArrayIndexKey: lines have no stable key here and never reorder
							key={i}
							className="break-inside-avoid border-b border-[#e3e3e3] align-top"
						>
							<td className="py-2 text-[13pt] font-bold tabular-nums">
								{l.quantity}
							</td>
							<td className="py-2">
								<p>{l.title}</p>
								{l.sku && <p className="text-[9pt] text-[#616161]">{l.sku}</p>}
							</td>
							<td className="py-2 text-right tabular-nums">
								{formatMoney(l.unitPrice)}
							</td>
							<td className="py-2 text-right tabular-nums">
								{formatMoney(l.unitPrice * l.quantity)}
							</td>
						</tr>
					))}
				</tbody>
			</table>

			<dl className="ml-auto grid w-64 grid-cols-[1fr_auto] gap-y-1 tabular-nums [&_dd]:pl-6">
				<dt>Subtotal</dt>
				<dd className="text-right">{formatMoney(subtotal)}</dd>
				<dt>Shipping</dt>
				<dd className="text-right">{formatMoney(o.shippingCharged)}</dd>
				{Math.abs(rest) >= 0.01 && (
					<>
						<dt>{rest > 0 ? "Tax" : "Discount"}</dt>
						<dd className="text-right">{formatMoney(rest)}</dd>
					</>
				)}
				<dt className="border-t-2 border-black pt-1 font-bold">Total</dt>
				<dd className="border-t-2 border-black pt-1 text-right font-bold">
					{formatMoney(o.total)}
				</dd>
			</dl>

			<p className="mt-auto text-center text-[#616161]">
				Thank you for your order.
			</p>
		</article>
	);
}

// US numbers as (717) 766-0608; anything else as given.
function formatPhone(phone: string) {
	const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
	return digits.length === 10
		? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
		: phone;
}

// "2 : 4 : 20" is order pin, box pin, and ounces; "-" where quick ship has
// nothing to suggest yet.
function packLine(pin: number, boxPin: number | null, grams: number | null) {
	const ounces =
		grams === null
			? "-"
			: String(Math.round((grams / GRAMS_PER_OUNCE) * 10) / 10);
	return `${pin} : ${boxPin ?? "-"} : ${ounces}`;
}
