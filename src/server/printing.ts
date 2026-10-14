import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { getQzCertificate, qzSignature } from "#/printing/qz";

// What the browser hands QZ Tray so it trusts the request: the certificate,
// and a signature for each request made with the key, which stays here.
// Only reachable signed in, so nobody else can sign print jobs as katasync.

export const qzCertificateText = createServerFn({ method: "GET" }).handler(
	async () => (await getQzCertificate(getDb())).certificate,
);

// The request itself, checked before it's signed (qzSignature). It carries
// the label as base64, so it's allowed to be big, but not unboundedly.
export const signQzRequest = createServerFn({ method: "POST" })
	.validator(type("string <= 10000000"))
	.handler(async ({ data }) => {
		const { privateKey } = await getQzCertificate(getDb());
		return qzSignature(data, privateKey);
	});
