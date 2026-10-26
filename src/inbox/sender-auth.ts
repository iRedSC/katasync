// Whether an email's From can be believed: anyone can write any From, so a
// buyer's email is only filed as theirs when Microsoft vouched for it.
// Exchange Online stamps its Authentication-Results above every header the
// email already had, so only the first is its own; one further down could
// be written by the sender. It counts when composite authentication passed
// (compauth=pass) or DMARC passed for the From address's own domain. No
// header, or anything else, is not vouched for.

export type Header = { name: string; value: string };

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
		const from = /\bheader\.from=([^\s;]+)/i.exec(part)?.[1]?.toLowerCase();
		return { method: method.toLowerCase(), result: result.toLowerCase(), from };
	});
	return results.some(
		(r) =>
			r.result === "pass" &&
			(r.method === "compauth" || (r.method === "dmarc" && r.from === domain)),
	);
}
