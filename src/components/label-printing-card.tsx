import { useCallback, useEffect, useState } from "react";
import { Badge, Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
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
			title={
				<span className="flex items-center gap-2">
					Label printing
					{qz.state === "checking" ? (
						<Badge>Checking…</Badge>
					) : qz.state === "on" ? (
						<Badge tone="success">QZ Tray connected</Badge>
					) : (
						<Badge tone="warning">QZ Tray not connected</Badge>
					)}
				</span>
			}
			aside={
				<Tip content="Once per packing computer. If Windows warns, choose Keep, then Run.">
					<Button asChild size="sm" variant="outline">
						<a href="/labels/setup" download>
							Download setup
						</a>
					</Button>
				</Tip>
			}
			flush
		>
			{qz.state === "off" && (
				<div className="flex items-start justify-between gap-3 px-4 pb-3">
					<p className="font-mono text-xs break-words text-muted-foreground">
						{qz.why}
					</p>
					<Button size="sm" variant="outline" onClick={check}>
						Try again
					</Button>
				</div>
			)}
			{qz.state === "on" && (
				<div className="flex items-center gap-2 px-4 pb-3">
					<label htmlFor="label-printer" className="sr-only">
						Label printer
					</label>
					<select
						id="label-printer"
						value={printer ?? ""}
						onChange={(e) => setLabelPrinter(e.target.value || null)}
						className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-white px-2"
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
				</div>
			)}
		</Card>
	);
}
