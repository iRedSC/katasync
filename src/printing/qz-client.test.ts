import { afterEach, beforeEach, expect, test, vi } from "vitest";

type Signer = (
	request: string,
) => (
	resolve: (signature: string) => void,
	reject: (error: unknown) => void,
) => void;

const mocks = vi.hoisted(() => ({
	printer: vi.fn(),
	open: vi.fn(),
	fetch: vi.fn(),
	sign: vi.fn(),
	toast: { success: vi.fn(), error: vi.fn() },
	qz: {
		websocket: { isActive: vi.fn(), connect: vi.fn() },
		printers: { find: vi.fn() },
		configs: { create: vi.fn() },
		print: vi.fn(),
		api: { setSha256Type: vi.fn() },
		security: {
			setCertificatePromise: vi.fn(),
			setSignatureAlgorithm: vi.fn(),
			setSignaturePromise: vi.fn((signer: Signer) => signer),
		},
	},
}));

vi.mock("qz-tray", () => ({ default: mocks.qz }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("#/server/printing", () => ({
	qzCertificateText: vi.fn(async () => "certificate"),
	signQzRequest: mocks.sign,
}));

beforeEach(() => {
	vi.resetModules();
	vi.resetAllMocks();
	mocks.printer.mockReturnValue("Zebra");
	mocks.qz.websocket.isActive.mockReturnValue(true);
	mocks.qz.printers.find.mockResolvedValue(["Zebra"]);
	mocks.qz.configs.create.mockReturnValue({ printer: "Zebra" });
	mocks.qz.print.mockResolvedValue(undefined);
	mocks.fetch.mockImplementation(async () => new Response("%PDF-1.7 test"));
	mocks.sign.mockResolvedValue("signature");
	vi.stubGlobal("localStorage", { getItem: mocks.printer });
	vi.stubGlobal("window", { open: mocks.open });
	vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => vi.unstubAllGlobals());

test("a computer without a selected printer opens the PDF without QZ", async () => {
	mocks.printer.mockReturnValue(null);
	const { printLabel } = await import("./qz-client");
	await printLabel(7);
	expect(mocks.open).toHaveBeenCalledWith("/labels/7", "_blank");
	expect(mocks.qz.printers.find).not.toHaveBeenCalled();
});

test("a stale printer name never falls back to a similar printer", async () => {
	mocks.qz.printers.find.mockResolvedValue(["Zebra (Copy 1)"]);
	const { printLabel } = await import("./qz-client");
	await printLabel(7);
	expect(mocks.qz.print).not.toHaveBeenCalled();
	expect(mocks.fetch).not.toHaveBeenCalled();
	expect(mocks.toast.error).toHaveBeenCalledWith(
		expect.stringContaining("was not found"),
		expect.objectContaining({
			action: expect.objectContaining({ label: "Open PDF" }),
		}),
	);
});

test("every box is sent in one 4x6 PDF print job", async () => {
	const { printLabels } = await import("./qz-client");
	await printLabels([7, 8]);
	expect(mocks.fetch.mock.calls.map(([path]) => path)).toEqual([
		"/labels/7",
		"/labels/8",
	]);
	expect(mocks.qz.configs.create).toHaveBeenCalledWith(
		"Zebra",
		expect.objectContaining({ size: { width: 4, height: 6 }, units: "in" }),
	);
	expect(mocks.qz.print).toHaveBeenCalledTimes(1);
	expect(mocks.qz.print.mock.calls[0][1]).toEqual([
		expect.objectContaining({ type: "pixel", format: "pdf", flavor: "base64" }),
		expect.objectContaining({ type: "pixel", format: "pdf", flavor: "base64" }),
	]);
});

test("a missing PDF prints no boxes and offers the first PDF", async () => {
	mocks.fetch.mockResolvedValueOnce(new Response("missing", { status: 404 }));
	const { printLabels } = await import("./qz-client");
	await printLabels([7, 8]);
	expect(mocks.qz.print).not.toHaveBeenCalled();
	expect(mocks.toast.error).toHaveBeenCalledWith(
		expect.stringContaining("missing"),
		expect.anything(),
	);
});

test("a signing rejection keeps its clock correction message", async () => {
	mocks.sign.mockRejectedValue(new Error("Set this computer's clock right"));
	mocks.qz.print.mockImplementation(async () => {
		const signer = mocks.qz.security.setSignaturePromise.mock.calls[0][0];
		await new Promise<string>((resolve, reject) => {
			signer("request")(resolve, () =>
				reject(new Error("Failed to sign request")),
			);
		});
	});
	const { printLabel } = await import("./qz-client");
	await printLabel(7);
	expect(mocks.toast.error).toHaveBeenCalledWith(
		expect.stringContaining("Set this computer's clock right"),
		expect.anything(),
	);
});

test("print jobs take turns rather than sharing a signing failure", async () => {
	let release = () => {};
	mocks.qz.print.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const { printLabel } = await import("./qz-client");
	const first = printLabel(7);
	const second = printLabel(8);
	await vi.waitFor(() => expect(mocks.qz.print).toHaveBeenCalledTimes(1));
	expect(mocks.fetch).toHaveBeenCalledTimes(1);
	release();
	await Promise.all([first, second]);
	expect(mocks.qz.print).toHaveBeenCalledTimes(2);
});

test("a failed job does not block the next job", async () => {
	mocks.qz.print.mockRejectedValueOnce(new Error("printer offline"));
	const { printLabel } = await import("./qz-client");
	await Promise.all([printLabel(7), printLabel(8)]);
	expect(mocks.qz.print).toHaveBeenCalledTimes(2);
	expect(mocks.toast.error).toHaveBeenCalledTimes(1);
	expect(mocks.toast.success).toHaveBeenCalledTimes(1);
});
