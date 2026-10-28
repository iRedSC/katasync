// Whether an email's From can be believed: anyone can write any From, so a
// buyer's email is only filed as theirs when Microsoft vouched for it.
// Exchange Online stamps its Authentication-Results above every header the
// email already had, so only the first is its own; one further down could
// be written by the sender. It counts when DMARC passed for the From
// address's own domain, or SPF or DKIM passed for that domain or one under
// or over it (relaxed alignment, for a domain without a DMARC record:
// dmarc=none). A DMARC fail settles it.
// Composite authentication (compauth) alone doesn't count: Microsoft passes
// it implicitly (by reverse DNS, or despite an SPF fail) without proof the
// sender owns the From domain. No header, or anything else, is not vouched
// for.

export type Header = { name: string; value: string };

const aligned = (from: string, d: string | undefined) =>
	d !== undefined &&
	(d === from || d.endsWith(`.${from}`) || from.endsWith(`.${d}`));

export function senderAuthenticated(headers: Header[], fromAddress: string) {
	const stamp = headers.find(
		(h) => h.name.trim().toLowerCase() === "authentication-results",
	)?.value;
	if (!stamp) return false;
	const domain = fromAddress.trim().toLowerCase().split("@")[1];
	if (!domain) return false;
	const results = stamp.split(";").map((part) => {
		const [method = "", result = ""] =
			/^\s*([a-z]+)\s*=\s*([a-z]+)/i.exec(part)?.slice(1) ?? [];
		const prop = (name: string) =>
			new RegExp(`\\b${name}=([^\\s;]+)`, "i")
				.exec(part)?.[1]
				?.toLowerCase()
				.replace(/^.*@/, "");
		return {
			method: method.toLowerCase(),
			result: result.toLowerCase(),
			from: prop("header\\.from"),
			mailFrom: prop("smtp\\.mailfrom"),
			signer: prop("header\\.d"),
		};
	});
	// A domain's own DMARC failing settles it, whatever else passed.
	if (
		results.some(
			(r) => r.method === "dmarc" && r.result !== "pass" && r.result !== "none",
		)
	)
		return false;
	return results.some(
		(r) =>
			r.result === "pass" &&
			((r.method === "dmarc" && r.from === domain) ||
				(r.method === "spf" && aligned(domain, r.mailFrom)) ||
				(r.method === "dkim" && aligned(domain, r.signer))),
	);
}
