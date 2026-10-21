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
	tag,
}: {
	email: ReadableEmail;
	selected: boolean;
	onOpen: () => void;
	tag?: ReactNode;
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
				className={cn(
					"block w-full border-l-2 px-4 py-2.5 text-left",
					selected
						? "border-l-primary bg-surface-strong"
						: "border-l-transparent hover:bg-subtle",
				)}
			>
				<span className="flex items-baseline gap-2">
					<span className="min-w-0 flex-1 truncate font-semibold">
						{e.fromName ?? e.fromAddress}
					</span>
					{e.attachments.length > 0 && (
						<Paperclip className="size-3.5 shrink-0 self-center text-muted-foreground" />
					)}
					<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
						{formatDay(e.receivedAt)}
					</span>
				</span>
				<span className="block truncate">{e.subject || "(no subject)"}</span>
				<span className="flex items-center gap-2">
					<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
						{snippet(e.body)}
					</span>
					{tag && (
						<span className="shrink-0 rounded-md bg-surface-strong px-1.5 text-xs font-medium tabular-nums">
							{tag}
						</span>
					)}
				</span>
			</button>
		</li>
	);
}
