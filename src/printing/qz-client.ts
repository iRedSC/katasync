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

// QZ Tray, connected. Loaded and told how to sign once; reconnects if QZ
// was restarted since.
export async function qzConnected(): Promise<Qz> {
	loading ??= import("qz-tray").then((mod) => {
		// A CommonJS module: Vite puts it on `default`.
		const qz = (mod as Qz & { default?: Qz }).default ?? mod;
		qz.security.setCertificatePromise((resolve, reject) => {
			qzCertificateText().then(resolve, reject);
		});
		qz.security.setSignatureAlgorithm("SHA512");
		qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
			signQzRequest({ data: toSign }).then(resolve, reject);
		});
		return qz;
	});
	const qz = await loading;
	if (!qz.websocket.isActive()) {
		connecting ??= qz.websocket
			.connect({ retries: 1, delay: 1 })
			.catch((err: unknown) => {
				throw new Error(
					`QZ Tray isn't running on this computer (${message(err)}). Start it, or run the setup from Settings.`,
				);
			})
			.finally(() => {
				connecting = null;
			});
		await connecting;
	}
	return qz;
}

export async function qzPrinters(): Promise<string[]> {
	const qz = await qzConnected();
	const found = await qz.printers.find();
	return Array.isArray(found) ? found : [found];
}

// Prints a label, or opens it when this computer has no label printer. A
// failed print says why and offers the PDF instead.
export function printLabel(shipmentId: number) {
	return printPdf(labelPath(shipmentId), "Label");
}

export async function printPdf(path: string, what: string) {
	const printer = labelPrinter();
	const open = () => window.open(path, "_blank");
	if (!printer) return void open();
	try {
		const qz = await qzConnected();
		const response = await fetch(path);
		if (!response.ok) throw new Error(await response.text());
		const data = toBase64(await response.arrayBuffer());
		// Our labels are 4x6 PDFs (Shippo's PDF_4x6, TikTok's A6).
		const config = qz.configs.create(printer, {
			size: { width: 4, height: 6 },
			units: "in",
			colorType: "blackwhite",
		});
		await qz.print(config, [
			{ type: "pixel", format: "pdf", flavor: "base64", data },
		]);
		toast.success(`${what} sent to ${printer}`);
	} catch (err) {
		toast.error(`${what} didn't print on ${printer}: ${message(err)}`, {
			action: { label: "Open PDF", onClick: open },
			duration: 15_000,
		});
	}
}

function toBase64(buffer: ArrayBuffer) {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function message(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}
