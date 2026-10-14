import {
	createHash,
	createPrivateKey,
	createSign,
	createVerify,
	X509Certificate,
} from "node:crypto";
import { describe, expect, test } from "vitest";
import { createTestDb } from "#/test/db";
import {
	getQzCertificate,
	makeCertificate,
	QzRequestError,
	qzSetupScript,
	qzSignature,
} from "./qz";

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

describe("QZ request signing", async () => {
	const { certificate, privateKey } = await makeCertificate();
	const now = 1_792_000_000_000;
	const request = (call: string, params: object | null, timestamp = now) =>
		JSON.stringify({ call, params, timestamp });
	const pdf = { type: "pixel", format: "pdf", flavor: "base64", data: "JVBE" };
	const label = (printer: object, data: object[] = [pdf]) =>
		request("print", { printer, options: { copies: 1 }, data });

	test("signs SHA-256 hex of the request as it came, the way QZ checks it", () => {
		const text = request("print", {
			printer: { name: "Zebra ZP450 — Büro 📦" },
			options: {},
			data: [pdf],
		});
		const hash = createHash("sha256").update(text).digest("hex");
		const signature = qzSignature(text, privateKey, now);
		const cert = new X509Certificate(certificate);
		expect(
			createVerify("SHA512")
				.update(hash)
				.verify(cert.publicKey, signature, "base64"),
		).toBe(true);
		// qz-tray 2.3.0's own hash (_qz.SHA.hash) of this text, non-ASCII and all.
		const sample =
			'{"call":"print","params":{"printer":{"name":"Zebra ZP450 — Büro 📦"},"data":[]},"timestamp":1792000000000}';
		expect(createHash("sha256").update(sample).digest("hex")).toBe(
			"3bc0c2af69688e2e8bbfd8b2bb20c9985eaa6771fa0429b829b57cfb04ce95bb",
		);
	});

	test("signs listing printers and printing a PDF to one by name", () => {
		for (const text of [
			request("printers.find", {}),
			request("printers.find", { query: "Zebra" }),
			label({ name: "Zebra" }),
		])
			expect(qzSignature(text, privateKey, now)).toBeTruthy();
	});

	test("refuses everything else QZ can do", () => {
		for (const text of [
			request("socket.open", { host: "10.0.0.1", port: 22 }),
			request("serial.openPort", { port: "COM1" }),
			request("usb.claimDevice", { vendorId: "0x1" }),
			request("hid.claimDevice", { vendorId: "0x1" }),
			request("file.write", { path: "C:/x.bat", data: "evil" }),
			request("printers.getDefault", null),
			label({ file: "C:/Users/Public/x.bat" }),
			label({ name: "Zebra", file: "C:/x" }),
			label({ host: "10.0.0.1", port: 9100 }),
			label({ name: "Zebra" }, []),
			label({ name: "Zebra" }, [{ ...pdf, type: "raw", format: "command" }]),
			label({ name: "Zebra" }, [{ ...pdf, format: "html" }]),
			label({ name: "Zebra" }, [{ ...pdf, flavor: "file" }]),
			label({ name: "Zebra" }, [{ ...pdf, extra: 1 }]),
		])
			expect(() => qzSignature(text, privateKey, now), text).toThrow(
				QzRequestError,
			);
		expect(() => qzSignature("not json", privateKey, now)).toThrow();
	});

	test("refuses a request stamped more than a minute away", () => {
		const find = (timestamp: number) => request("printers.find", {}, timestamp);
		expect(qzSignature(find(now - 59_000), privateKey, now)).toBeTruthy();
		expect(() => qzSignature(find(now - 61_000), privateKey, now)).toThrow(
			/clock/,
		);
		expect(() => qzSignature(find(now + 61_000), privateKey, now)).toThrow(
			QzRequestError,
		);
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
