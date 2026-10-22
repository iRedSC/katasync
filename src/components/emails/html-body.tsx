import { type ReactNode, useEffect, useRef, useState } from "react";
import { getEmailHtml } from "#/server/inbox";

// An email as it was sent: its HTML in a frame that runs no script and
// submits no form, so a sender's email can do nothing on katasync but be
// read. Links open in a new tab. The frame grows to the email's height, so
// the reader scrolls it like the plain text. Pictures load from wherever the
// email points (the marketplaces' own servers, or katasync for ones it kept).

// What a frame's document allows: pictures and styles, nothing that runs.
const POLICY =
	"default-src 'none'; img-src https: http: data: 'self'; style-src 'unsafe-inline' https:; font-src https: data:";

function document(html: string) {
	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}"><base target="_blank"><style>body{margin:0;padding:16px 20px;font:14px/1.5 system-ui,sans-serif;color:#1a1a1a;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${html}</body></html>`;
}

function HtmlFrame({ html }: { html: string }) {
	const ref = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(200);
	useEffect(() => {
		const frame = ref.current;
		if (!frame) return;
		let observer: ResizeObserver | null = null;
		const fit = () => {
			const doc = frame.contentDocument;
			if (!doc?.documentElement) return;
			setHeight(doc.documentElement.scrollHeight);
			// Pictures arriving late make it taller.
			observer?.disconnect();
			observer = new ResizeObserver(() =>
				setHeight(doc.documentElement.scrollHeight),
			);
			observer.observe(doc.documentElement);
		};
		frame.addEventListener("load", fit);
		return () => {
			frame.removeEventListener("load", fit);
			observer?.disconnect();
		};
	}, []);
	return (
		<iframe
			ref={ref}
			title="Email"
			srcDoc={document(html)}
			// No allow-scripts: same origin only lets the page measure it.
			sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
			style={{ height }}
			className="block w-full border-0 bg-white"
		/>
	);
}

// The email's body: formatted when katasync has its HTML, else the text.
// Asks for the HTML when the email opens, not with the list, since it can
// be large.
export function EmailBody({
	box,
	id,
	text,
}: {
	box: "purchasing" | "marketplaces";
	id: number;
	text: ReactNode;
}) {
	const [state, setState] = useState<
		{ kind: "loading" } | { kind: "html"; html: string } | { kind: "text" }
	>({ kind: "loading" });
	useEffect(() => {
		let live = true;
		getEmailHtml({ data: { box, id } })
			.then((html) => {
				if (live) setState(html ? { kind: "html", html } : { kind: "text" });
			})
			.catch(() => {
				if (live) setState({ kind: "text" });
			});
		return () => {
			live = false;
		};
	}, [box, id]);
	if (state.kind === "loading") return <div className="min-h-40" />;
	if (state.kind === "html") return <HtmlFrame html={state.html} />;
	return text;
}
