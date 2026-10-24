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
import QRCode from "qrcode";
import type { Db } from "#/db/client";
import { people, repairs } from "#/db/repair-schema";
import { orderLines, orders } from "#/db/schema";
import { formatPhone } from "#/lib/format";

// The 4x6 ticket tied to a tool left for repair: its number and whose it
// is, big enough to read across the shop, and a QR code that opens the
// repair in katasync (a phone's camera, or the scanner into the board's
// search). A bench job's says it's ours, and the order it came back on.

export type RepairTicket = {
	id: number;
	customerName: string | null;
	// A bench job's: the order it came back on, if it did.
	bench: boolean;
	returnOrder: string | null;
	customerPhone: string | null;
	tool: string;
	serial: string | null;
	problem: string;
	technician: string | null;
	createdAt: Date;
};

export async function repairTicket(
	db: Db,
	id: number,
): Promise<RepairTicket | null> {
	const [row] = await db
		.select({
			id: repairs.id,
			customerName: repairs.customerName,
			bench: sql<boolean>`${repairs.kind} = 'bench'`,
			returnOrder: sql<
				string | null
			>`(select o.name from ${orderLines} l join ${orders} o on o.id = l.order_id where l.id = ${repairs.returnLineId})`,
			customerPhone: repairs.customerPhone,
			tool: repairs.tool,
			serial: repairs.serial,
			problem: repairs.problem,
			technician: people.name,
			createdAt: repairs.createdAt,
		})
		.from(repairs)
		.leftJoin(people, eq(people.id, repairs.technicianId))
		.where(eq(repairs.id, id));
	return row ?? null;
}

export async function renderRepairTicket(ticket: RepairTicket, origin: string) {
	const qr = await QRCode.toDataURL(`${origin}/repairs/${ticket.id}`, {
		margin: 0,
		width: 600,
	});
	return renderToBuffer(
		<Document title={`R${ticket.id} repair ticket`} author="katasync">
			<Page size={[288, 432]} style={s.page}>
				<View style={s.top}>
					<Text style={s.number}>R{ticket.id}</Text>
					<Image src={qr} style={s.qr} />
				</View>
				<Text style={s.customer}>
					{ticket.bench ? "IN-HOUSE REFURB" : ticket.customerName}
				</Text>
				{ticket.returnOrder && (
					<Text style={s.phone}>Return {ticket.returnOrder}</Text>
				)}
				{ticket.customerPhone && (
					<Text style={s.phone}>{formatPhone(ticket.customerPhone)}</Text>
				)}
				<View style={s.rule} />
				<Text style={s.tool}>{ticket.tool}</Text>
				{ticket.serial && <Text style={s.detail}>Serial {ticket.serial}</Text>}
				{ticket.problem && <Text style={s.problem}>{ticket.problem}</Text>}
				<View style={s.footer}>
					<Text>
						In{" "}
						{ticket.createdAt.toLocaleDateString("en-US", {
							dateStyle: "medium",
							timeZone: "America/New_York",
						})}
					</Text>
					{ticket.technician && <Text>{ticket.technician}</Text>}
				</View>
			</Page>
		</Document>,
	);
}

const s = StyleSheet.create({
	page: { padding: 18, fontFamily: "Helvetica", fontSize: 11, gap: 6 },
	top: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
	},
	number: { fontSize: 44, fontFamily: "Helvetica-Bold" },
	qr: { width: 96, height: 96 },
	customer: { fontSize: 24, fontFamily: "Helvetica-Bold", marginTop: 8 },
	phone: { fontSize: 18 },
	rule: { borderBottomWidth: 2, borderColor: "#000", marginVertical: 6 },
	tool: { fontSize: 16, fontFamily: "Helvetica-Bold" },
	detail: { fontSize: 12 },
	problem: { fontSize: 12, color: "#222", maxLines: 8 },
	footer: {
		marginTop: "auto",
		flexDirection: "row",
		justifyContent: "space-between",
		fontSize: 10,
		color: "#444",
	},
});
