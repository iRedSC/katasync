import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import type { Db } from "#/db/client";
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

// QZ wants RSA 2048. Valid for 30 years, since replacing it means running
// the setup script on every packing computer again.
export async function makeCertificate() {
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

// The Windows setup script with the certificate filled in. cmd needs CRLF.
export function qzSetupScript(certificate: string) {
	return setupScript
		.replace("KATASYNC_CERTIFICATE", certificate.trim())
		.replace(/\r?\n/g, "\r\n");
}
