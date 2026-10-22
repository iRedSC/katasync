import { Paperclip } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { formatDay } from "#/lib/format";
import { cn } from "#/lib/utils";
import { type ReadableEmail, snippet } from "./reader";

// An email in a mail list: sender, subject, the start of the body, and a tag
// for what's known about it. The open one scrolls into view as j and k move.
export function EmailRow({
	email: e,
	selected,
	onOpen,
	onMenu,
	tag,
	unread,
	critical,
}: {
	email: ReadableEmail;
	selected: boolean;
	onOpen: () => void;
	// Right-clicked, for the list's menu.
	onMenu?: () => void;
	tag?: ReactNode;
	// Bold, with a dot, until it's read.
	unread?: boolean;
	// Needs someone now: the row is red.
	critical?: boolean;
}) {
	const ref = useRef<HTMLLIElement>(null);
	useEffect(() => {
		if (selected) ref.current?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	return (
		<li ref={ref}>
			<button
				type="button"
				onClick={onOpen}
				onContextMenu={onMenu}
				className={cn(
					"block w-full border-l-2 px-4 py-2.5 text-left transition-colors",
					critical
						? cn(
								"border-l-critical-icon text-critical-text",
								selected
									? "bg-critical-fill"
									: "bg-critical-surface hover:bg-critical-fill",
							)
						: selected
							? "border-l-primary bg-surface-strong"
							: "border-l-transparent hover:bg-subtle",
				)}
			>
				<span className="flex items-baseline gap-2">
					{unread && (
						<span
							className={cn(
								"size-2 shrink-0 self-center rounded-full",
								critical ? "bg-critical-icon" : "bg-primary",
							)}
						>
							<span className="sr-only">Unread</span>
						</span>
					)}
					<span
						className={cn(
							"min-w-0 flex-1 truncate",
							unread === false ? "font-medium" : "font-semibold",
						)}
					>
						{e.fromName ?? e.fromAddress}
					</span>
					{e.attachments.length > 0 && (
						<Paperclip className="size-3.5 shrink-0 self-center text-muted-foreground" />
					)}
					<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
						{formatDay(e.receivedAt)}
					</span>
				</span>
				<span className={cn("block truncate", unread && "font-semibold")}>
					{e.subject || "(no subject)"}
				</span>
				<span className="flex items-center gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-xs",
							critical ? "text-critical-text/80" : "text-muted-foreground",
						)}
					>
						{snippet(e.body)}
					</span>
					{typeof tag === "string" || typeof tag === "number" ? (
						<span className="shrink-0 rounded-md bg-surface-strong px-1.5 text-xs font-medium tabular-nums">
							{tag}
						</span>
					) : (
						// A chip of its own (a marketplace's badge) needs no pill.
						tag && <span className="shrink-0">{tag}</span>
					)}
				</span>
			</button>
		</li>
	);
}
