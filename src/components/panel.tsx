import type { ReactNode } from "react";
import { Badge, type Tone } from "#/components/page";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { cn } from "#/lib/utils";

// Pages of things to glance at (Diagnostics): a tile per thing, saying how
// it is, opening a side panel with the detail.

export const DOT: Record<Tone, string> = {
	critical: "bg-critical-icon",
	warning: "bg-warning-icon",
	success: "bg-success-icon",
	info: "bg-info-icon",
};

export function TileGrid({
	label,
	children,
}: {
	label?: string;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-2">
			{label && (
				<h2 className="text-xs font-medium text-muted-foreground">{label}</h2>
			)}
			<div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
				{children}
			</div>
		</section>
	);
}

// `status` puts a dot before the name: a tone, or "neutral" for a state
// that's neither good nor bad (not connected). Without it, no dot.
export function Tile({
	name,
	detail,
	status,
	onClick,
}: {
	name: string;
	detail: string;
	status?: Tone | "neutral";
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex flex-col gap-0.5 rounded-xl bg-card p-3 text-left shadow-card hover:bg-subtle",
				status === "critical" && "ring-1 ring-critical-border",
			)}
		>
			<span className="flex items-center gap-2 font-medium">
				{status && (
					<span
						className={cn(
							"size-2 shrink-0 rounded-full",
							status === "neutral" ? "bg-faint" : DOT[status],
						)}
					/>
				)}
				{name}
			</span>
			<span className="truncate text-xs text-muted-foreground">{detail}</span>
		</button>
	);
}

export function SidePanel({
	open,
	onClose,
	children,
}: {
	open: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="top-0 right-0 left-auto flex h-dvh w-full max-w-lg translate-x-0 translate-y-0 flex-col gap-4 overflow-y-auto rounded-none border-y-0 border-r-0 p-5 sm:max-w-lg data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right">
				{children}
			</DialogContent>
		</Dialog>
	);
}

// The panel's title, a status when it has one, and its actions on the right,
// clear of the close button.
export function PanelHeader({
	title,
	status,
	children,
}: {
	title: string;
	status?: { label: string; tone?: Tone };
	children?: ReactNode;
}) {
	return (
		<div className="flex min-h-8 items-center gap-2 pr-8">
			<DialogTitle className="text-base">{title}</DialogTitle>
			{status && <Badge tone={status.tone}>{status.label}</Badge>}
			<span className="flex-1" />
			{children}
		</div>
	);
}
