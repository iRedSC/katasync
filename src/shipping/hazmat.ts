import { PDFDocument, rgb } from "pdf-lib";

// katasync's hazmat is aerosols (UN1950), shipped as Limited Quantity. That
// rules out air: USPS takes them by Ground Advantage only, UPS and FedEx by
// ground. Anything not known to be ground is left out, so a new service
// can't slip an aerosol onto a plane.
const GROUND = [
	/\bground advantage\b/i,
	/\bups\b.*\bground\b(?!.*\bsaver\b)/i,
	/\bfedex\b.*\b(ground|home delivery)\b/i,
];

export function shipsAerosols(rate: { serviceName: string }) {
	return GROUND.some((g) => g.test(rate.serviceName.replace(/[®™]/g, "")));
}

// Shippo's own declaration: USPS labels get the "H" marker and Shippo
// keeps air services off them.
export const shippoDangerousGoods = { contains: true } as const;

// Points per millimeter.
const MM = 72 / 25.4;

// A 4x6 page with the Limited Quantity mark, to stick on the box beside the
// shipping label: a square on point, black top and bottom, white center,
// 100 mm across (49 CFR 172.315).
export async function appendAerosolMark(label: Uint8Array) {
	const doc = await PDFDocument.load(label);
	const page = doc.addPage([288, 432]);
	const cx = 144;
	const cy = 216;
	const outer = 50 * MM;
	const border = 2.5 * MM * Math.SQRT2;
	const inner = outer - border;
	// The white center band's half height.
	const band = inner * 0.32;
	page.drawSvgPath(`M ${-outer} 0 L 0 ${-outer} L ${outer} 0 L 0 ${outer} Z`, {
		x: cx,
		y: cy,
		color: rgb(0, 0, 0),
		borderWidth: 0,
	});
	page.drawSvgPath(
		[
			`M ${-inner} 0`,
			`L ${-(inner - band)} ${-band}`,
			`L ${inner - band} ${-band}`,
			`L ${inner} 0`,
			`L ${inner - band} ${band}`,
			`L ${-(inner - band)} ${band}`,
			"Z",
		].join(" "),
		{ x: cx, y: cy, color: rgb(1, 1, 1), borderWidth: 0 },
	);
	return Buffer.from(await doc.save());
}
