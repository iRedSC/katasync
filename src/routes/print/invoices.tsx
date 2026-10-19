import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { cityLine, formatMoney, formatPhone } from "#/lib/format";
import { listInvoices } from "#/server/orders";

// One letter-size invoice per order still to ship, in pin order, or just
// the orders picked: ?ids=[1,2] from the orders list, ?id=1 from one order.
// Opens the print dialog on its own.
export const Route = createFileRoute("/print/invoices")({
	validateSearch: (search: Record<string, unknown>): { ids?: number[] } => {
		const picked = (Array.isArray(search.ids) ? search.ids : [search.id])
			.map(Number)
			.filter((n) => Number.isInteger(n) && n > 0);
		return picked.length > 0 ? { ids: picked } : {};
	},
	loaderDeps: ({ search }) => ({ ids: search.ids }),
	loader: ({ deps }) =>
		listInvoices({ data: deps.ids ? { ids: deps.ids } : {} }),
	head: () => ({ meta: [{ title: "Invoices" }] }),
	component: Invoices,
});

const GRAMS_PER_OUNCE = 28.349523125;

// What the invoice can truthfully say about payment. A partial refund still
// means the total was paid. Shopify's PARTIALLY_PAID carries no amount, so
// the invoice says so instead of guessing what's owed; a status it doesn't
// know (or none) says nothing.
type Payment = "paid" | "unpaid" | "partial" | "unknown";
function payment(status: string | null): Payment {
	switch (status) {
		case "PAID":
		case "PARTIALLY_REFUNDED":
			return "paid";
		case "PENDING":
		case "AUTHORIZED":
		case "EXPIRED":
			return "unpaid";
		case "PARTIALLY_PAID":
			return "partial";
		default:
			return "unknown";
	}
}

type Data = Awaited<ReturnType<typeof listInvoices>>;

function Invoices() {
	const { from, invoices } = Route.useLoaderData();
	const { ids } = Route.useSearch();

	// Item photos load from the stores' CDNs; printing before they arrive
	// prints empty boxes. Waits for each to load or fail, at most a few
	// seconds, so a slow CDN can't hold the print dialog forever.
	useEffect(() => {
		if (invoices.length === 0) return;
		let cancelled = false;
		const loaded = [...document.images].map((img) =>
			img.complete
				? Promise.resolve()
				: new Promise<void>((done) => {
						img.addEventListener("load", () => done(), { once: true });
						img.addEventListener("error", () => done(), { once: true });
					}),
		);
		const timeout = new Promise<void>((done) => setTimeout(done, 5000));
		Promise.race([Promise.all(loaded), timeout]).then(() => {
			if (!cancelled) window.print();
		});
		return () => {
			cancelled = true;
		};
	}, [invoices.length]);

	return (
		<div className="min-h-svh bg-surface py-6 print:bg-white print:py-0">
			<style>{"@page { size: letter; margin: 0.5in; }"}</style>
			<div className="mx-auto mb-4 flex max-w-[8.5in] items-center justify-between print:hidden">
				<span className="text-muted-foreground">
					{invoices.length} {invoices.length === 1 ? "invoice" : "invoices"}
				</span>
				<button
					type="button"
					onClick={() => window.print()}
					className="h-8 rounded-lg bg-primary px-3 font-semibold text-white hover:bg-primary-hover"
				>
					Print
				</button>
			</div>
			{invoices.length === 0 && (
				<p className="text-center text-muted-foreground">
					{ids ? "Those orders are gone." : "Nothing to ship."}
				</p>
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
	const paid = payment(o.financialStatus);
	// Amazon and TikTok hide the buyer when they sell the label: no name, or
	// a masked one, and no street. The label carries the address, so the
	// page is a packing slip instead: what's in the box, no ship-to, no
	// prices (the marketplace sent its own receipt). One check decides both,
	// so an order can't print as an invoice addressed to no one.
	const buyer = shownBuyer(o);
	const slip = buyer === null;

	return (
		<article className="mx-auto mb-6 flex min-h-[11in] max-w-[8.5in] flex-col gap-8 bg-white p-[0.5in] text-[11pt] text-black shadow-card break-after-page last:break-after-auto print:m-0 print:min-h-[9.95in] print:max-w-none print:p-0 print:shadow-none">
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
					<p className="text-[20pt] font-bold">
						{slip ? "Packing Slip" : "Invoice"}
					</p>
					<p className="font-semibold">{o.name}</p>
					<p>
						{new Date(o.placedAt).toLocaleDateString("en-US", {
							month: "long",
							day: "numeric",
							year: "numeric",
						})}
					</p>
					{o.salesChannel && (
						<p className="text-muted-foreground">{o.salesChannel}</p>
					)}
				</div>
			</header>

			{buyer && (
				<section>
					<p className="text-[9pt] font-semibold tracking-wide text-muted-foreground uppercase">
						Ship to
					</p>
					<p className="text-[13pt] font-semibold">{buyer.name}</p>
					{buyer.lines.map((l) => (
						<p key={l}>{l}</p>
					))}
				</section>
			)}

			<table className="w-full border-collapse">
				<thead>
					<tr className="border-b-2 border-black text-left text-[9pt] tracking-wide uppercase">
						<th className="w-14 py-1.5 font-semibold">Qty</th>
						<th className="py-1.5 font-semibold">Item</th>
						{!slip && (
							<>
								<th className="w-24 py-1.5 text-right font-semibold">Price</th>
								<th className="w-24 py-1.5 text-right font-semibold">Total</th>
							</>
						)}
					</tr>
				</thead>
				<tbody>
					{o.lines.map((l, i) => (
						<tr
							// biome-ignore lint/suspicious/noArrayIndexKey: lines have no stable key here and never reorder
							key={i}
							className="break-inside-avoid border-b border-border align-top"
						>
							<td className="py-2 text-[13pt] font-bold tabular-nums">
								{l.quantity}
							</td>
							<td className="py-2">
								<div className="flex items-start gap-3">
									<Photo src={l.imageUrl} className="size-[0.6in]" />
									<div>
										<p>{l.title}</p>
										{l.sku && (
											<p className="text-[9pt] text-muted-foreground">
												{l.sku}
											</p>
										)}
									</div>
								</div>
								{l.parts.length > 0 && (
									<ul className="mt-2 ml-[calc(0.6in+0.75rem)] flex flex-col gap-1.5 border-l-2 border-border pl-3">
										{l.parts.map((p) => (
											<li key={p.sku} className="flex items-center gap-2">
												<Photo src={p.imageUrl} className="size-[0.35in]" />
												<span className="w-8 font-bold tabular-nums">
													{p.perSet * l.quantity}
												</span>
												<span className="min-w-0">
													<span>
														{p.variantName
															? `${p.name}, ${p.variantName}`
															: p.name}
													</span>
													<span className="ml-2 text-[9pt] text-muted-foreground">
														{p.sku}
													</span>
												</span>
											</li>
										))}
									</ul>
								)}
							</td>
							{!slip && (
								<>
									<td className="py-2 text-right tabular-nums">
										{formatMoney(l.unitPrice)}
									</td>
									<td className="py-2 text-right tabular-nums">
										{formatMoney(l.unitPrice * l.quantity)}
									</td>
								</>
							)}
						</tr>
					))}
				</tbody>
			</table>

			{!slip && (
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
					{paid === "paid" && (
						<>
							<dt>Paid</dt>
							<dd className="text-right">{formatMoney(o.total)}</dd>
							<dt className="font-bold">Balance due</dt>
							<dd className="text-right font-bold">{formatMoney(0)}</dd>
						</>
					)}
					{paid === "unpaid" && (
						<>
							<dt className="font-bold">Balance due</dt>
							<dd className="text-right font-bold">{formatMoney(o.total)}</dd>
						</>
					)}
					{paid === "partial" && (
						<dt className="col-span-2 font-bold">Partially paid</dt>
					)}
				</dl>
			)}

			{/* What the packer needs, small in the bottom corner. */}
			<footer className="mt-auto flex items-end justify-between gap-6">
				<p className="text-muted-foreground">Thank you for your order.</p>
				{o.pin !== null && (
					<div className="flex flex-col items-end gap-1 text-[8pt] text-muted-foreground">
						{o.shipsWith.length > 0 && (
							<p>
								Ships with{" "}
								<span className="font-semibold text-black">
									{o.shipsWith
										.map((c) =>
											c.pin === null ? c.name : `${c.name} (${c.pin})`,
										)
										.join(", ")}
								</span>
							</p>
						)}
						<dl className="flex gap-4 rounded-md border border-border px-2.5 py-1 tabular-nums">
							<PackFact label="Pin" value={String(o.pin)} />
							{o.box && (
								<PackFact
									label={o.boxes > 1 ? `Box 1 of ${o.boxes}` : "Box"}
									value={
										<>
											{o.box.name && <span>{o.box.name} </span>}
											<span
												className={
													o.box.name ? "font-normal text-muted-foreground" : ""
												}
											>
												{o.box.size}
											</span>
										</>
									}
								/>
							)}
							{o.weightGrams !== null && (
								<PackFact label="Weight" value={ounces(o.weightGrams)} />
							)}
						</dl>
					</div>
				)}
			</footer>
		</article>
	);
}

function ounces(grams: number) {
	return `${Math.round((grams / GRAMS_PER_OUNCE) * 10) / 10} oz`;
}

// Who the order goes to, or null when the marketplace hid them: no street,
// or a name that's missing or masked the way TikTok sends it ("D*****").
function shownBuyer(o: Data["invoices"][number]) {
	const name = o.customerName;
	if (!o.shipAddress1 || !name || name.includes("*")) return null;
	const lines = [
		o.shipAddress1,
		o.shipAddress2,
		cityLine(o.shipCity, o.shipRegion, o.shipPostalCode),
		o.shipCountry && o.shipCountry !== "US" ? o.shipCountry : null,
	].filter((l): l is string => !!l);
	return { name, lines };
}

function PackFact({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="flex flex-col">
			<dt className="text-[6.5pt] tracking-wide uppercase">{label}</dt>
			<dd className="text-[10pt] font-semibold text-black">{value}</dd>
		</div>
	);
}

// A product photo, or nothing when there's none or it fails to load: a
// printed placeholder icon tells the packer nothing.
function Photo({ src, className }: { src: string | null; className: string }) {
	const [failed, setFailed] = useState(false);
	if (!src || failed) return <div className={`${className} shrink-0`} />;
	return (
		<img
			src={src}
			alt=""
			onError={() => setFailed(true)}
			className={`${className} shrink-0 rounded border border-border object-contain`}
		/>
	);
}
