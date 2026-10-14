import { useCallback, useEffect, useState } from "react";
import { Badge, Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import {
	printPdf,
	qzPrinters,
	setLabelPrinter,
	useLabelPrinter,
} from "#/printing/qz-client";

type Qz =
	| { state: "checking" }
	| { state: "off"; why: string }
	| { state: "on"; printers: string[] };

// This computer's label printer. QZ Tray is what lets katasync print without
// a dialog; the setup script installs it and makes it trust katasync.
export function LabelPrintingCard() {
	const printer = useLabelPrinter();
	const [qz, setQz] = useState<Qz>({ state: "checking" });

	const check = useCallback(async () => {
		setQz({ state: "checking" });
		try {
			setQz({ state: "on", printers: await qzPrinters() });
		} catch (err) {
			setQz({
				state: "off",
				why: err instanceof Error ? err.message : String(err),
			});
		}
	}, []);
	useEffect(() => {
		check();
	}, [check]);

	// A saved printer that's gone (renamed, unplugged) stays listed, so the
	// choice shows instead of silently becoming another one.
	const printers =
		qz.state === "on"
			? printer && !qz.printers.includes(printer)
				? [printer, ...qz.printers]
				: qz.printers
			: [];

	return (
		<Card
			title="Label printing"
			aside={
				<Button asChild size="sm" variant="outline">
					<a href="/labels/setup" download>
						Download setup
					</a>
				</Button>
			}
			flush
		>
			<div className="flex items-center justify-between gap-3 px-4 py-3">
				<span className="font-medium">QZ Tray on this computer</span>
				{qz.state === "checking" ? (
					<Badge>Checking…</Badge>
				) : qz.state === "on" ? (
					<Badge tone="success">Connected</Badge>
				) : (
					<span className="flex items-center gap-2">
						<Badge tone="warning">Not connected</Badge>
						<Button size="sm" variant="ghost" onClick={check}>
							Try again
						</Button>
					</span>
				)}
			</div>
			{qz.state === "off" && (
				<p className="border-t px-4 py-3 text-muted-foreground">{qz.why}</p>
			)}
			{qz.state === "on" && (
				<div className="flex items-center justify-between gap-3 border-t px-4 py-3">
					<label htmlFor="label-printer" className="font-medium">
						Label printer
					</label>
					<span className="flex items-center gap-2">
						<select
							id="label-printer"
							value={printer ?? ""}
							onChange={(e) => setLabelPrinter(e.target.value || null)}
							className="h-8 max-w-64 rounded-lg border border-input bg-white px-2"
						>
							<option value="">None: open labels as PDFs</option>
							{printers.map((p) => (
								<option key={p} value={p}>
									{qz.printers.includes(p) ? p : `${p} (not found)`}
								</option>
							))}
						</select>
						<Button
							size="sm"
							variant="outline"
							disabled={!printer}
							onClick={() => printPdf("/labels/test", "Test label")}
						>
							Test print
						</Button>
					</span>
				</div>
			)}
			<p className="border-t px-4 py-3 text-muted-foreground">
				Set up each Windows packing computer once: download the setup, open it,
				and click Yes. It installs QZ Tray if needed and lets katasync print
				without asking. If the browser or Windows warns about the file, choose
				Keep, then Run. Then pick the label printer here, on that computer.
			</p>
		</Card>
	);
}
