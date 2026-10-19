import { createHash, createSign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { type } from "arktype";
import { type Db, getDb } from "#/db/client";
import { qzCertificate } from "#/db/schema";
import setupScript from "./qz-setup.bat?raw";

// QZ Tray prints from the browser without asking, as long as the page signs
// each request with a key whose certificate QZ trusts. katasync makes its own
// self-signed one, and the setup script makes each packing computer trust it
// (QZ sells trusted certificates, at $749 a year).

// The key pair, made and saved the first time it's asked for. Two requests
// racing to make it both get the one that was saved first.
export async function getQzCertificate(db: Db) {
	const [saved] = await db.select().from(qzCertificate);
	if (saved) return saved;
	await db
		.insert(qzCertificate)
		.values(await makeCertificate())
		.onConflictDoNothing();
	const [made] = await db.select().from(qzCertificate);
	return made;
}

type QzKeys = { certificate: string; privateKey: string };
let devKeys: Promise<QzKeys> | undefined;

// The key pair to sign with. The dev server skips sign-in (src/start.ts) and
// its database may be a copy of production's, so it won't use the saved one.
// Printing from dev needs QZ_DEV_PRINTING=1, and then gets a certificate of
// its own, kept in .qz-dev-certificate.json; a computer set up from dev
// trusts only that.
export async function qzKeys(): Promise<QzKeys> {
	if (!import.meta.env.DEV) return getQzCertificate(getDb());
	if (process.env.QZ_DEV_PRINTING !== "1")
		throw new Error(
			"Label printing is off on the dev server. Set QZ_DEV_PRINTING=1 to print with a dev-only certificate.",
		);
	devKeys ??= (async () => {
		const file = ".qz-dev-certificate.json";
		try {
			return JSON.parse(await readFile(file, "utf8")) as QzKeys;
		} catch {
			const made = await makeCertificate();
			await writeFile(file, JSON.stringify(made), { mode: 0o600 });
			return made;
		}
	})();
	return devKeys;
}

// QZ wants RSA 2048. Valid for 30 years, since replacing it means running
// the setup script on every packing computer again.
export async function makeCertificate() {
	// @peculiar/x509 needs reflect-metadata loaded before it. Static imports
	// can't promise that order: the production bundle ran x509 first, which
	// crashed this whole module and took signing down with it.
	await import("reflect-metadata");
	const x509 = await import("@peculiar/x509");
	const algorithm = {
		name: "RSASSA-PKCS1-v1_5",
		hash: "SHA-256",
		publicExponent: new Uint8Array([1, 0, 1]),
		modulusLength: 2048,
	};
	const keys = await crypto.subtle.generateKey(algorithm, true, [
		"sign",
		"verify",
	]);
	const notBefore = new Date();
	const notAfter = new Date(notBefore);
	notAfter.setFullYear(notAfter.getFullYear() + 30);
	const certificate = await x509.X509CertificateGenerator.createSelfSigned({
		// Positive: the top bit of the first byte is clear.
		serialNumber: `01${Buffer.from(crypto.getRandomValues(new Uint8Array(15))).toString("hex")}`,
		name: "CN=katasync, O=katasync",
		notBefore,
		notAfter,
		signingAlgorithm: algorithm,
		keys,
		// It's the root QZ trusts, so it's marked as one.
		extensions: [
			new x509.BasicConstraintsExtension(true, undefined, true),
			new x509.KeyUsagesExtension(
				x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.digitalSignature,
				true,
			),
		],
	});
	const privateKey = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
	return {
		certificate: certificate.toString("pem"),
		privateKey: x509.PemConverter.encode(privateKey, "PRIVATE KEY"),
	};
}

// The only QZ requests katasync signs: listing printers, and printing PDFs to
// a printer by name. A signature lets a page on a packing computer use QZ
// without asking, so signing anything else (raw sockets, serial, USB and HID
// devices, files, or printing to a file or another host) would hand that to
// whoever holds a session.
const printerList = type({
	call: "'printers.find'",
	params: { "+": "reject", "query?": "string" },
	timestamp: "number",
});
const pdfPrint = type({
	call: "'print'",
	params: {
		"+": "reject",
		printer: { "+": "reject", name: "string" },
		options: "object",
		data: type({
			"+": "reject",
			type: "'pixel'",
			format: "'pdf'",
			flavor: "'base64'",
			data: "string",
			"options?": "object",
		})
			.array()
			.atLeastLength(1),
	},
	timestamp: "number",
});
const qzRequest = printerList.or(pdfPrint);

export class QzRequestError extends Error {
	name = "QzRequestError";
}

// QZ hands over each request as JSON (qz.api.setSha256Type in qz-client.ts
// passes it through instead of hashing it) and checks the signature against
// the SHA-256 hex of that exact text, so it's hashed as it came, never
// re-serialized. SHA512 to match setSignatureAlgorithm there.
export function qzSignature(
	request: string,
	privateKey: string,
	now = Date.now(),
) {
	const parsed = qzRequest(JSON.parse(request));
	if (parsed instanceof type.errors)
		throw new QzRequestError(`katasync only signs printing: ${parsed.summary}`);
	// So a signature made now can't be saved and used much later.
	if (Math.abs(now - parsed.timestamp) > 60_000)
		throw new QzRequestError(
			"This computer's clock is more than a minute off; set it right and try again",
		);
	const hash = createHash("sha256").update(request).digest("hex");
	return createSign("SHA512").update(hash).sign(privateKey, "base64");
}

// The Windows setup script with the certificate filled in. cmd needs CRLF.
export function qzSetupScript(certificate: string) {
	return setupScript
		.replace("KATASYNC_CERTIFICATE", certificate.trim())
		.replace(/\r?\n/g, "\r\n");
}
