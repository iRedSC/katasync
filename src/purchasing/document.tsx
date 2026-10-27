import {
	Document,
	Page,
	renderToBuffer,
	StyleSheet,
	Text,
	View,
} from "@react-pdf/renderer";
import { supplierUnit } from "#/lib/format";
import {
	coveredUnits,
	type Discount,
	describeDiscount,
	discountValues,
	lineCents,
} from "#/purchasing/discount";

// The PO as the supplier sees it: a one-column letter-size PDF, emailed as an
// attachment. Built from plain data so it can be rendered anywhere on the
// server.

export type PurchaseOrderDocument = {
	id: number;
	date: Date;
	// Us: the delivery location's ship-from details.
	buyer: Address & { email: string | null };
	supplier: Address & {
		contactName: string | null;
		email: string | null;
		paymentTerms: string | null;
	};
	notes: string[];
	lines: {
		lineNo: number;
		sku: string;
		supplierSku: string | null;
		description: string;
		unit: string;
		supplierCount: number;
		quantity: number;
		unitCost: number | null;
		// Each prints on its own row under the line.
		discounts: Discount[];
	}[];
};

type Address = {
	name: string;
	address1: string | null;
	address2: string | null;
	city: string | null;
	region: string | null;
	postalCode: string | null;
	country: string | null;
	phone: string | null;
};

const s = StyleSheet.create({
	page: { padding: 40, fontSize: 9, fontFamily: "Helvetica", color: "#303030" },
	header: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginBottom: 24,
	},
	title: { fontSize: 18, fontFamily: "Helvetica-Bold" },
	muted: { color: "#616161" },
	bold: { fontFamily: "Helvetica-Bold" },
	parties: { flexDirection: "row", gap: 24, marginBottom: 20 },
	party: { flex: 1, gap: 1 },
	label: {
		fontSize: 7,
		fontFamily: "Helvetica-Bold",
		color: "#616161",
		textTransform: "uppercase",
		marginBottom: 3,
	},
	row: {
		flexDirection: "row",
		borderBottomWidth: 0.5,
		borderBottomColor: "#e3e3e3",
		paddingVertical: 5,
	},
	headRow: {
		flexDirection: "row",
		borderBottomWidth: 1,
		borderBottomColor: "#303030",
		paddingBottom: 4,
	},
	lineNo: { width: 20, color: "#616161" },
	sku: { width: 90 },
	desc: { flex: 1, paddingRight: 8 },
	num: { width: 40, textAlign: "right" },
	unit: { width: 70, paddingLeft: 6 },
	money: { width: 70, textAlign: "right" },
	total: {
		flexDirection: "row",
		justifyContent: "flex-end",
		paddingTop: 8,
		gap: 12,
	},
	notes: { marginTop: 20, gap: 4 },
	discountRow: {
		flexDirection: "row",
		borderBottomWidth: 0.5,
		borderBottomColor: "#e3e3e3",
		paddingVertical: 3,
		color: "#616161",
	},
});

const money = (n: number) =>
	n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export function renderPurchaseOrder(po: PurchaseOrderDocument) {
	const total =
		po.lines.reduce((sum, l) => sum + (lineCents(l, l.discounts) ?? 0), 0) /
		100;
	const unpriced = po.lines.some((l) => l.unitCost === null);
	// Only some suppliers have part numbers; skip the column when none do.
	const theirSkus = po.lines.some((l) => l.supplierSku !== null);
	return renderToBuffer(
		<Document title={`Purchase order ${po.id}`} author={po.buyer.name}>
			<Page size="LETTER" style={s.page}>
				<View style={s.header}>
					<View>
						<Text style={s.title}>PO #{po.id}</Text>
						<Text style={s.muted}>
							{po.date.toLocaleDateString("en-US", { dateStyle: "long" })}
						</Text>
					</View>
					<Text style={s.bold}>{po.buyer.name}</Text>
				</View>

				<View style={s.parties}>
					<View style={s.party}>
						<Text style={s.label}>Supplier</Text>
						<AddressLines address={po.supplier} />
						{po.supplier.contactName && (
							<Text>Attn: {po.supplier.contactName}</Text>
						)}
						{po.supplier.email && <Text>{po.supplier.email}</Text>}
					</View>
					<View style={s.party}>
						<Text style={s.label}>Ship to</Text>
						<AddressLines address={po.buyer} />
						{po.buyer.email && <Text>{po.buyer.email}</Text>}
					</View>
					{po.supplier.paymentTerms && (
						<View style={s.party}>
							<Text style={s.label}>Terms</Text>
							<Text>{po.supplier.paymentTerms}</Text>
						</View>
					)}
				</View>

				<View style={s.headRow}>
					<Text style={[s.lineNo, s.bold]}>#</Text>
					{theirSkus && <Text style={[s.sku, s.bold]}>Supplier SKU</Text>}
					<Text style={[s.desc, s.bold]}>Item</Text>
					<Text style={[s.num, s.bold]}>Qty</Text>
					<Text style={[s.unit, s.bold]}>Unit</Text>
					<Text style={[s.money, s.bold]}>Unit price</Text>
					<Text style={[s.money, s.bold]}>Amount</Text>
				</View>
				{po.lines.map((l) => {
					const units = coveredUnits(l.quantity, l.discounts);
					const values = discountValues(l, l.discounts);
					return (
						<View key={l.sku} wrap={false}>
							<View style={s.row}>
								<Text style={s.lineNo}>{l.lineNo}</Text>
								{theirSkus && <Text style={s.sku}>{l.supplierSku ?? "—"}</Text>}
								<Text style={s.desc}>{l.description}</Text>
								<Text style={s.num}>{l.quantity}</Text>
								<Text style={s.unit}>{supplierUnit(l)}</Text>
								<Text style={s.money}>
									{l.unitCost === null ? "—" : money(l.unitCost)}
								</Text>
								<Text style={s.money}>
									{l.unitCost === null ? "—" : money(l.unitCost * l.quantity)}
								</Text>
							</View>
							{l.discounts
								.map((d, i) => ({
									says: describeDiscount(d, units[i], l.discounts.length > 1),
									value: values[i],
								}))
								.map(({ says, value }) => (
									<View key={says} style={s.discountRow}>
										<Text style={s.lineNo} />
										{theirSkus && <Text style={s.sku} />}
										<Text style={s.desc}>Discount: {says}</Text>
										<Text style={s.money}>
											{value === null ? "—" : money(-value)}
										</Text>
									</View>
								))}
						</View>
					);
				})}
				<View style={s.total}>
					<Text style={s.bold}>
						{unpriced ? "Total of priced items" : "Total"}
					</Text>
					<Text style={[s.money, s.bold]}>{money(total)}</Text>
				</View>

				{po.notes.length > 0 && (
					<View style={s.notes}>
						<Text style={s.label}>Notes</Text>
						{po.notes.map((n) => (
							<Text key={n}>{n}</Text>
						))}
					</View>
				)}
			</Page>
		</Document>,
	);
}

function AddressLines({ address: a }: { address: Address }) {
	const cityLine = [a.city, [a.region, a.postalCode].filter(Boolean).join(" ")]
		.filter(Boolean)
		.join(", ");
	return (
		<>
			<Text style={s.bold}>{a.name}</Text>
			{a.address1 && <Text>{a.address1}</Text>}
			{a.address2 && <Text>{a.address2}</Text>}
			{cityLine && <Text>{cityLine}</Text>}
			{a.country && a.country !== "US" && <Text>{a.country}</Text>}
			{a.phone && <Text>{a.phone}</Text>}
		</>
	);
}
