import { ArrowLeft, Download, FileText, Loader2, Mail } from "lucide-react";
import type { Email } from "postal-mime";
import { useEffect, useState } from "react";
import { formatDateTime } from "#/lib/format";
import { HtmlFrame } from "./html-body";
import { kb, MailText } from "./reader";

// An email saved as a file (.eml), as suppliers forward a carrier's or their
// office's: read here like any other, its files too. Parsed in the browser,
// so the server never runs a sender's MIME. Its HTML gets the same frame
// that runs nothing; its pictures inside it come along as data: URLs.

type Part = Email["attachments"][number];
type Load =
	| { state: "loading" }
	| { state: "failed"; message: string }
	| { state: "loaded"; email: Email };

const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const isEmail = (p: { mimeType: string; filename: string | null }) =>
	p.mimeType === "message/rfc822" || /\.eml$/i.test(p.filename ?? "");
const bytesOf = (p: Part) =>
	typeof p.content === "string"
		? new TextEncoder().encode(p.content)
		: new Uint8Array(p.content);
// What the page can show in itself; the rest download. A blob: URL is on
// our origin, so one the browser would run (HTML, SVG) is never made.
const kindOf = (p: Part) =>
	isEmail(p)
		? "email"
		: p.mimeType === "application/pdf"
			? "pdf"
			: IMAGE.test(p.mimeType)
				? "image"
				: "download";

const who = (a: Email["from"]) =>
	!a ? "" : a.address ? a.name || a.address : a.name;
const everyone = (list: Email["to"]) =>
	(list ?? [])
		.flatMap((a) => (a.group ? a.group : [a]))
		.map((a) => a.name || a.address)
		.join(", ");

async function parse(data: ArrayBuffer | Uint8Array) {
	const { default: PostalMime } = await import("postal-mime");
	return PostalMime.parse(data, { forceRfc822Attachments: true });
}

// From the server (url) or from inside another attached email (data).
export function AttachedEmail(props: { url: string } | { data: Uint8Array }) {
	const [load, setLoad] = useState<Load>({ state: "loading" });
	const source = "url" in props ? props.url : props.data;
	useEffect(() => {
		let live = true;
		setLoad({ state: "loading" });
		(typeof source === "string"
			? fetch(source).then((r) => {
					if (!r.ok) throw new Error(`Couldn't open it (${r.status})`);
					return r.arrayBuffer();
				})
			: Promise.resolve(source)
		)
			.then(parse)
			.then(
				(email) => live && setLoad({ state: "loaded", email }),
				(err) =>
					live &&
					setLoad({
						state: "failed",
						message: err instanceof Error ? err.message : String(err),
					}),
			);
		return () => {
			live = false;
		};
	}, [source]);

	if (load.state === "loading")
		return (
			<p className="flex min-h-40 items-center justify-center text-muted-foreground">
				<Loader2 className="size-4 animate-spin" />
			</p>
		);
	if (load.state === "failed")
		return <p className="px-5 py-4 text-critical-text">{load.message}</p>;
	return <Parsed email={load.email} />;
}

function Parsed({ email: e }: { email: Email }) {
	const [open, setOpen] = useState<Part | null>(null);
	const [urls] = useState(() => new Map<Part, string>());
	useEffect(
		() => () => {
			for (const u of urls.values()) URL.revokeObjectURL(u);
		},
		[urls],
	);
	const urlOf = (p: Part) => {
		let u = urls.get(p);
		if (!u) {
			const type =
				kindOf(p) === "download" ? "application/octet-stream" : p.mimeType;
			u = URL.createObjectURL(new Blob([bytesOf(p)], { type }));
			urls.set(p, u);
		}
		return u;
	};
	const files = e.attachments.filter((p) => !p.related);
	const html = e.html && withPictures(e.html, e.attachments);
	const to = everyone(e.to);
	const date = e.date ? new Date(e.date) : null;

	return (
		<div className="flex flex-col">
			<header className="border-b px-5 pt-3 pb-2 text-sm">
				<div className="flex items-baseline gap-2">
					<Mail className="size-3.5 shrink-0 self-center text-muted-foreground" />
					<span className="font-semibold break-words">
						{e.subject || "(no subject)"}
					</span>
					{date && !Number.isNaN(date.getTime()) && (
						<span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
							{formatDateTime(date)}
						</span>
					)}
				</div>
				<div className="text-muted-foreground">
					{who(e.from)}
					{to && <> to {to}</>}
				</div>
			</header>
			{files.length > 0 && (
				<nav className="flex flex-wrap gap-1.5 border-b px-5 py-2">
					{open && (
						<button
							type="button"
							onClick={() => setOpen(null)}
							className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-surface hover:text-foreground"
						>
							<ArrowLeft className="size-3.5" />
							Message
						</button>
					)}
					{files.map((p, i) => {
						const name =
							p.filename ||
							(isEmail(p) ? "Attached email.eml" : `File ${i + 1}`);
						const label = (
							<>
								<span className="truncate">{name}</span>
								<span className="shrink-0 font-normal text-muted-foreground">
									{kb(bytesOf(p).length)}
								</span>
							</>
						);
						const style =
							"inline-flex h-7 max-w-64 items-center gap-1.5 rounded-lg px-2 text-xs font-medium hover:bg-surface hover:text-foreground";
						return kindOf(p) === "download" ? (
							<a
								// biome-ignore lint/suspicious/noArrayIndexKey: parts have no id
								key={i}
								href={urlOf(p)}
								download={name}
								className={`${style} text-muted-foreground`}
							>
								<Download className="size-3.5 shrink-0" />
								{label}
							</a>
						) : (
							<button
								// biome-ignore lint/suspicious/noArrayIndexKey: parts have no id
								key={i}
								type="button"
								onClick={() => setOpen(p)}
								className={`${style} ${open === p ? "bg-surface-strong text-foreground" : "text-muted-foreground"}`}
							>
								{isEmail(p) ? (
									<Mail className="size-3.5 shrink-0" />
								) : (
									<FileText className="size-3.5 shrink-0" />
								)}
								{label}
							</button>
						);
					})}
				</nav>
			)}
			<div key={files.indexOf(open as Part)} className="animate-in fade-in-0">
				{open ? (
					kindOf(open) === "email" ? (
						<AttachedEmail data={bytesOf(open)} />
					) : kindOf(open) === "pdf" ? (
						<iframe
							src={urlOf(open)}
							title={open.filename ?? "PDF"}
							className="h-[70vh] w-full"
						/>
					) : (
						<img
							src={urlOf(open)}
							alt={open.filename ?? ""}
							className="mx-auto max-w-full p-3"
						/>
					)
				) : html ? (
					<HtmlFrame html={html} />
				) : (
					<p className="px-5 py-4 text-sm whitespace-pre-wrap break-words">
						{e.text ? (
							<MailText text={e.text.replace(/\n{3,}/g, "\n\n")} />
						) : (
							<span className="text-muted-foreground">(empty)</span>
						)}
					</p>
				)}
			</div>
		</div>
	);
}

// The pictures an email's HTML names by cid:, put in as data: URLs.
function withPictures(html: string, parts: Part[]) {
	let out = html;
	for (const p of parts) {
		const id = p.contentId?.replace(/^<|>$/g, "");
		if (!id || !IMAGE.test(p.mimeType)) continue;
		let binary = "";
		for (const b of bytesOf(p)) binary += String.fromCharCode(b);
		out = out
			.split(`cid:${id}`)
			.join(`data:${p.mimeType};base64,${btoa(binary)}`);
	}
	return out;
}
