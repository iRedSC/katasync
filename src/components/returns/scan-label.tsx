import { Loader2, ScanBarcode } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatOrderDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { ReturnOrder } from "#/orders/returns-due";
import { scanReturnLabel } from "#/server/orders";

// Waiting for a scanner (it types the barcode and Enter) to read a return
// label or packing slip, then handing over the one order it's for. Typing
// works the same.

type Scan =
	| { kind: "ready" }
	| { kind: "looking"; code: string }
	| { kind: "missed"; code: string; why: "none" | "failed"; tries: number }
	| { kind: "many"; code: string; orders: ReturnOrder[] };

export function ScanLabel({
	open,
	onOpenChange,
	onFound,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onFound: (order: ReturnOrder) => void;
}) {
	const [scan, setScan] = useState<Scan>({ kind: "ready" });
	const [code, setCode] = useState("");
	const latest = useRef(0);
	const input = useRef<HTMLInputElement>(null);

	async function look(e: FormEvent) {
		e.preventDefault();
		const scanned = code.trim();
		if (!scanned) return;
		// A scan that a newer one overtook is dropped.
		const asked = ++latest.current;
		setCode("");
		setScan({ kind: "looking", code: scanned });
		const tries = scan.kind === "missed" ? scan.tries + 1 : 0;
		try {
			const found = await scanReturnLabel({ data: { code: scanned } });
			if (asked !== latest.current) return;
			if (found.length === 1) {
				setScan({ kind: "ready" });
				onFound(found[0]);
			} else if (found.length === 0)
				setScan({ kind: "missed", code: scanned, why: "none", tries });
			else setScan({ kind: "many", code: scanned, orders: found });
		} catch {
			if (asked === latest.current)
				setScan({ kind: "missed", code: scanned, why: "failed", tries });
		}
		input.current?.focus();
	}

	const missed = scan.kind === "missed";
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) {
					// A lookup still out answers nobody once it's closed.
					latest.current++;
					setScan({ kind: "ready" });
				}
				onOpenChange(o);
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Scan the return label</DialogTitle>
					<DialogDescription>
						Or type its tracking or order number
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={look} className="flex flex-col items-center gap-4 py-2">
					{scan.kind === "looking" ? (
						<Loader2 className="size-14 animate-spin text-muted-foreground" />
					) : (
						<ScanBarcode
							className={cn(
								"size-14",
								missed
									? "text-critical-text"
									: "text-info-text motion-safe:animate-pulse",
							)}
						/>
					)}
					<input
						// Remounted on each miss, so the shake plays again.
						key={missed ? `miss${scan.tries}` : "ready"}
						ref={input}
						autoFocus
						value={code}
						onChange={(e) => setCode(e.target.value)}
						aria-label="Tracking or order number"
						aria-invalid={missed}
						className={cn(
							"h-10 w-full rounded-lg border border-input bg-white px-3 text-center font-mono text-base outline-none focus:border-ring",
							missed && "border-destructive motion-safe:animate-shake",
						)}
					/>
					{missed && (
						<p className="text-sm text-critical-text">
							{scan.why === "none"
								? `No order for ${scan.code}`
								: "Couldn't look it up. Scan again."}
						</p>
					)}
				</form>
				{scan.kind === "many" && (
					<ul className="-mx-2 flex flex-col">
						{scan.orders.map((o) => (
							<li key={o.id}>
								<button
									type="button"
									onClick={() => {
										setScan({ kind: "ready" });
										onFound(o);
									}}
									className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-subtle"
								>
									<span className="font-semibold">{o.name}</span>
									<ChannelBadge
										channel={o.channel}
										salesChannel={o.salesChannel}
									/>
									<span className="min-w-0 flex-1 truncate text-muted-foreground">
										{o.customerName ?? "No name"}
									</span>
									<span className="text-xs text-muted-foreground">
										{formatOrderDate(o.placedAt)}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</DialogContent>
		</Dialog>
	);
}
