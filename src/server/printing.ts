import { createSign } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { getQzCertificate } from "#/printing/qz";

// What the browser hands QZ Tray so it trusts the request: the certificate,
// and a signature for each request made with the key, which stays here.
// Only reachable signed in, so nobody else can sign print jobs as katasync.

export const qzCertificateText = createServerFn({ method: "GET" }).handler(
	async () => (await getQzCertificate(getDb())).certificate,
);

// QZ asks for SHA512 (set in src/printing/qz-client.ts), base64.
export const signQzRequest = createServerFn({ method: "POST" })
	.validator(type("string"))
	.handler(async ({ data }) => {
		const { privateKey } = await getQzCertificate(getDb());
		return createSign("SHA512").update(data).sign(privateKey, "base64");
	});
