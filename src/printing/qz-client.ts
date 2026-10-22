import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { qzCertificateText, signQzRequest } from "#/server/printing";
import { labelPath } from "#/shipping/label-path";

// Printing labels through QZ Tray on this computer. Browser only.
//
// Each computer picks its own label printer (Settings, then Label printing),
// kept in this browser. Without one, labels open as PDFs in a new tab, which
// is how phones and computers without QZ Tray print.

const PRINTER_KEY = "katasync:label-printer";
const listeners = new Set<() => void>();

export function labelPrinter(): string | null {
	return localStorage.getItem(PRINTER_KEY);
}

export function setLabelPrinter(name: string | null) {
	if (name) localStorage.setItem(PRINTER_KEY, name);
	else localStorage.removeItem(PRINTER_KEY);
	for (const listener of listeners) listener();
}

export function useLabelPrinter() {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		labelPrinter,
		() => null,
	);
}

type Qz = typeof import("qz-tray");
let loading: Promise<Qz> | null = null;
let connecting: Promise<void> | null = null;
let signingError: unknown = null;
let requestTail: Promise<unknown> = Promise.resolve();

function qzRequest<Result>(use: (qz: Qz) => Promise<Result>): Promise<Result> {
	const pending = requestTail.then(async () => {
		signingError = null;
		try {
			return await use(await qzConnected());
		} catch (error) {
			throw signingError ?? error;
		} finally {
			signingError = null;
		}
	});
	requestTail = pending.catch(() => {});
	return pending;
}

// QZ Tray, connected. Loaded and told how to sign once; reconnects if QZ
// was restarted since. QZ reports the socket active before it has the
// certificate, so a connection still being made is always waited for.
export async function qzConnected(): Promise<Qz> {
	loading ??= import("qz-tray").then(setUpQz, (err: unknown) => {
		// Tried again next time (say, a chunk gone after a deploy) instead of
		// being remembered until the page reloads.
		loading = null;
		throw err;
	});
	const qz = await loading;
	if (!connecting && !qz.websocket.isActive())
		connecting = qz.websocket
			.connect({ retries: 1, delay: 1 })
			.catch((err: unknown) => {
				// Connected without katasync's certificate: hang up, so the next
				// try sends it rather than reusing an anonymous connection.
				if (signingError) {
					qz.websocket.disconnect().catch(() => {});
					throw signingError;
				}
				throw new Error(
					`QZ Tray isn't running (${message(err)}). Start it, or run the setup from Settings.`,
				);
			})
			.finally(() => {
				connecting = null;
			});
	await connecting;
	return qz;
}

// Tells a freshly loaded qz-tray where its certificate and signatures come from.
function setUpQz(mod: Qz) {
	// A CommonJS module: Vite puts it on `default`.
	const qz = (mod as Qz & { default?: Qz }).default ?? mod;
	// Without a certificate or with an empty signature, QZ doesn't fail: it
	// treats the page as anonymous and asks about every request, with no way
	// to remember the answer. So anything else stops the request and says why.
	const fail = (reject: (reason: string) => void) => (error: unknown) => {
		signingError = error;
		reject(message(error));
	};
	qz.security.setCertificatePromise(
		(resolve, reject) => {
			qzCertificateText().then((certificate: unknown) => {
				if (
					typeof certificate === "string" &&
					certificate.includes("BEGIN CERTIFICATE")
				)
					resolve(certificate);
				else
					fail(reject)(
						new Error(
							`katasync's server sent no QZ certificate (got ${described(certificate)})`,
						),
					);
			}, fail(reject));
		},
		{ rejectOnFailure: true },
	);
	qz.security.setSignatureAlgorithm("SHA512");
	// Hand the server the request itself rather than its hash, so it can
	// check what it signs. The server hashes it the way QZ would.
	// (Its types are wrong: qz-tray.js passes the request and uses what's
	// returned, see _qz.tools.hash.)
	const passThrough = (request: string) => request;
	qz.api.setSha256Type(
		passThrough as unknown as Parameters<Qz["api"]["setSha256Type"]>[0],
	);
	qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
		signQzRequest({ data: toSign }).then((signature: unknown) => {
			if (typeof signature === "string" && signature) resolve(signature);
			else
				fail(reject)(
					new Error(
						`katasync's server sent no QZ signature (got ${described(signature)})`,
					),
				);
		}, fail(reject));
	});
	return qz;
}

export async function qzPrinters(): Promise<string[]> {
	return qzRequest(async (qz) => {
		const found = await qz.printers.find();
		return Array.isArray(found) ? found : [found];
	});
}

// Prints a label, or opens it when this computer has no label printer. A
// failed print says why and offers the PDF instead.
export function printLabel(shipmentId: number) {
	return printPdf(labelPath(shipmentId), "Label");
}

export function printLabels(shipmentIds: number[]) {
	return printPdfs(shipmentIds.map(labelPath), "Labels");
}

export async function printPdf(path: string, what: string) {
	return printPdfs([path], what);
}

async function printPdfs(paths: string[], what: string) {
	const [first] = paths;
	if (first === undefined) return;
	const printer = labelPrinter();
	const open = () => openPdfs(paths);
	if (!printer) return void open();
	try {
		await qzRequest(async (qz) => {
			const found = await qz.printers.find();
			const printers = Array.isArray(found) ? found : [found];
			if (!printers.includes(printer)) {
				throw new Error(
					`Printer "${printer}" was not found; choose a printer in Settings`,
				);
			}
			const data = await downloadLabels(paths);
			const config = qz.configs.create(printer, {
				size: { width: 4, height: 6 },
				units: "in",
				colorType: "blackwhite",
			});
			await qz.print(config, data);
		});
		toast.success(`${what} sent to ${printer}`);
	} catch (err) {
		toast.error(`${what} didn't print on ${printer}: ${message(err)}`, {
			action: { label: "Open PDF", onClick: open },
			duration: 15_000,
		});
	}
}

// Every label's data, or none. A failed download cancels the rest and waits
// for them to stop, so no reader outlives the attempt. Only this download can
// be cancelled: once QZ has the job, it prints.
async function downloadLabels(paths: string[]) {
	const abort = new AbortController();
	const failures: unknown[] = [];
	const settled = await Promise.allSettled(
		paths.map(async (path) => {
			try {
				const response = await fetch(path, { signal: abort.signal });
				if (!response.ok) throw new Error(await response.text());
				return {
					type: "pixel" as const,
					format: "pdf" as const,
					flavor: "base64" as const,
					data: toBase64(await response.arrayBuffer()),
				};
			} catch (error) {
				// The first failure is the one reported; the rest are its cancellations.
				failures.push(error);
				abort.abort();
				throw error;
			}
		}),
	);
	if (failures.length > 0) throw failures[0];
	return settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

// Opens the labels in one tab, joined into one PDF; a single label opens as it
// is. The tab opens first, while the click still allows one, and the PDF goes
// into it once the labels are joined.
async function openPdfs(paths: string[]) {
	if (paths.length === 1) return void window.open(paths[0], "_blank");
	const tab = window.open("", "_blank");
	try {
		if (!tab) throw new Error("the browser blocked the new tab");
		const { PDFDocument } = await import("pdf-lib");
		const joined = await PDFDocument.create();
		for (const path of paths) {
			const response = await fetch(path);
			if (!response.ok) throw new Error(await response.text());
			const label = await PDFDocument.load(await response.arrayBuffer());
			const pages = await joined.copyPages(label, label.getPageIndices());
			for (const page of pages) joined.addPage(page);
		}
		const pdf = new Uint8Array(await joined.save());
		const blob = new Blob([pdf], { type: "application/pdf" });
		tab.location.href = URL.createObjectURL(blob);
	} catch (err) {
		tab?.close();
		toast.error(`The labels didn't open: ${message(err)}`);
	}
}

function toBase64(buffer: ArrayBuffer) {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

// What came back instead, short enough for a toast.
function described(value: unknown) {
	if (value === undefined) return "nothing";
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return `${typeof value} ${(text ?? "").slice(0, 60) || "(empty)"}`;
}

function message(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}
