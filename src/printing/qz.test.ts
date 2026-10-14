import {
	createPrivateKey,
	createSign,
	createVerify,
	X509Certificate,
} from "node:crypto";
import { describe, expect, test } from "vitest";
import { createTestDb } from "#/test/db";
import { getQzCertificate, makeCertificate, qzSetupScript } from "./qz";

describe("QZ Tray certificate", () => {
	test("is a self-signed root whose key signs what QZ checks", async () => {
		const { certificate, privateKey } = await makeCertificate();
		const cert = new X509Certificate(certificate);
		expect(cert.ca).toBe(true);
		expect(cert.verify(cert.publicKey)).toBe(true);
		expect(cert.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
		expect(new Date(cert.validTo).getFullYear()).toBeGreaterThan(
			new Date().getFullYear() + 29,
		);
		// QZ verifies SHA512 signatures of each request against the certificate.
		const signature = createSign("SHA512")
			.update("print")
			.sign(createPrivateKey(privateKey));
		expect(
			createVerify("SHA512").update("print").verify(cert.publicKey, signature),
		).toBe(true);
	});

	test("is made once and kept", async () => {
		const db = await createTestDb();
		const [a, b] = await Promise.all([
			getQzCertificate(db),
			getQzCertificate(db),
		]);
		expect(a.certificate).toBe(b.certificate);
		expect((await getQzCertificate(db)).privateKey).toBe(a.privateKey);
	});
});

test("the setup script carries the certificate, with CRLF for cmd", async () => {
	const { certificate } = await makeCertificate();
	const script = qzSetupScript(certificate);
	expect(script).not.toContain("KATASYNC_CERTIFICATE");
	expect(script).toContain(certificate.trim().replace(/\r?\n/g, "\r\n"));
	expect(script.replace(/\r\n/g, "")).not.toContain("\n");
	expect(script.startsWith("<# :\r\n@echo off")).toBe(true);
});
