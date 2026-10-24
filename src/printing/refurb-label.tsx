import {
	Document,
	Image,
	Page,
	renderToBuffer,
	StyleSheet,
	Text,
	View,
} from "@react-pdf/renderer";
import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import QRCode from "qrcode";
import type { Db } from "#/db/client";
import { repairs } from "#/db/repair-schema";
import { orderLines, orderReturns, orders, products } from "#/db/schema";

// A 4x6 label for the box a refurbished unit sits in until it ships, one
// per receipt: its SKU, big, and as a QR code of its barcode (the same
// SKU, in katasync and Shopify) to scan, with what it is, its condition,
// notes about the unit, and the return it came from.

export type RefurbLabel = {
	sku: string;
	name: string;
	condition: string;
	notes: string | null;
	originalSku: string;
	quantity: number;
	orderName: string;
	receivedAt: Date;
};

const original = alias(products, "original");

// The label for a refurbished receipt, or null when the return wasn't one.
export async function refurbLabel(
	db: Db,
	returnId: number,
): Promise<RefurbLabel | null> {
	const [row] = await db
		.select({
			sku: products.sku,
			name: products.name,
			condition: products.condition,
			notes: products.notes,
			originalSku: original.sku,
			quantity: orderReturns.quantity,
			orderName: orders.name,
			receivedAt: orderReturns.createdAt,
		})
		.from(orderReturns)
		.innerJoin(products, eq(products.id, orderReturns.refurbProductId))
		.innerJoin(original, eq(original.id, products.refurbishedFromId))
		.innerJoin(orderLines, eq(orderLines.id, orderReturns.orderLineId))
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.where(eq(orderReturns.id, returnId));
	if (!row?.condition) return null;
	return { ...row, condition: conditionName(row.condition) };
}

// The label for a listed bench job's refurb: the order its unit came back
// on, or the job itself for one bought in.
export async function benchLabel(
	db: Db,
	repairId: number,
): Promise<RefurbLabel | null> {
	const [row] = await db
		.select({
			sku: products.sku,
			name: products.name,
			condition: products.condition,
			notes: products.notes,
			originalSku: original.sku,
			orderName: sql<
				string | null
			>`(select o.name from ${orderLines} l join ${orders} o on o.id = l.order_id where l.id = ${repairs.returnLineId})`,
			receivedAt: repairs.statusChangedAt,
		})
		.from(repairs)
		.innerJoin(products, eq(products.id, repairs.refurbProductId))
		.innerJoin(original, eq(original.id, products.refurbishedFromId))
		.where(eq(repairs.id, repairId));
	if (!row?.condition) return null;
	return {
		...row,
		quantity: 1,
		orderName: row.orderName ?? `R${repairId}`,
		condition: conditionName(row.condition),
	};
}

// A Shopify condition handle as words: "new-previous-gen" → "New previous gen".
export const conditionName = (handle: string) =>
	handle.charAt(0).toUpperCase() + handle.slice(1).replace(/-/g, " ");

export async function renderRefurbLabel(label: RefurbLabel) {
	const qr = await QRCode.toDataURL(label.sku, { margin: 0, width: 600 });
	return renderToBuffer(
		<Document title={`${label.sku} label`} author="katasync">
			<Page size={[288, 432]} style={s.page}>
				<Text style={s.sku}>{label.sku}</Text>
				<Image src={qr} style={s.qr} />
				<Text style={s.condition}>{label.condition}</Text>
				<Text style={s.name}>{label.name}</Text>
				{label.notes && <Text style={s.notes}>{label.notes}</Text>}
				<View style={s.footer}>
					<Text>
						{label.quantity > 1 ? `${label.quantity} × ` : ""}
						{label.originalSku} returned on {label.orderName}
					</Text>
					<Text>
						{label.receivedAt.toLocaleDateString("en-US", {
							dateStyle: "medium",
						})}
					</Text>
				</View>
			</Page>
		</Document>,
	);
}

const s = StyleSheet.create({
	page: {
		padding: 18,
		fontFamily: "Helvetica",
		fontSize: 11,
		alignItems: "center",
		gap: 10,
	},
	sku: { fontSize: 26, fontFamily: "Helvetica-Bold", textAlign: "center" },
	qr: { width: 170, height: 170 },
	condition: {
		fontSize: 16,
		fontFamily: "Helvetica-Bold",
		borderWidth: 2,
		borderColor: "#000",
		paddingHorizontal: 10,
		paddingVertical: 3,
	},
	name: { fontSize: 13, textAlign: "center" },
	notes: { fontSize: 11, textAlign: "center", color: "#333" },
	footer: {
		marginTop: "auto",
		alignItems: "center",
		gap: 2,
		fontSize: 9,
		color: "#444",
	},
});
