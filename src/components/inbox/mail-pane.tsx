import { ArrowLeft } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import {
	EmailReader,
	type FileUrl,
	type ReadableEmail,
} from "#/components/emails/reader";
import { EmailRow } from "#/components/emails/row";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";

// A mailbox as a mail app: the list on the left, the open email on the
// right. j and k move through the list; when the open email leaves it (filed,
// done), the one after it opens. On a phone the list and the email take
// turns. Each mailbox brings its own tags, actions, and keys.
export function MailPane<E extends ReadableEmail>({
	emails,
	tagOf,
	actionsOf,
	keysOf,
	menuOf,
	box,
	fileUrl,
	empty,
}: {
	box: "purchasing" | "marketplaces";
	emails: E[];
	tagOf?: (e: E) => ReactNode;
	actionsOf: (e: E) => ReactNode;
	// Shortcuts for the open email, e.g. e for done.
	keysOf?: (e: E) => Record<string, () => void>;
	// The right-click menu's items for an email in the list.
	menuOf?: (e: E) => ReactNode;
	fileUrl?: FileUrl;
	empty: ReactNode;
}) {
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [reading, setReading] = useState(false);
	const [menuFor, setMenuFor] = useState<E | null>(null);
	// Where the open email sat, so the one after it opens once it leaves.
	const lastIndex = useRef(0);
	const found = emails.findIndex((e) => e.id === selectedId);
	const index =
		found >= 0 ? found : Math.min(lastIndex.current, emails.length - 1);
	lastIndex.current = Math.max(index, 0);
	const selected = emails[index] ?? null;

	const step = (by: number) => {
		const next = emails[index + by];
		if (next) setSelectedId(next.id);
	};
	useHotkeys({
		j: () => step(1),
		k: () => step(-1),
		...(selected && keysOf ? keysOf(selected) : {}),
	});

	if (selected === null) return empty;
	return (
		<div className="grid md:h-[calc(100svh-14rem)] md:min-h-[30rem] md:grid-cols-[24rem_minmax(0,1fr)]">
			<ContextMenu>
				<ContextMenuTrigger asChild disabled={!menuOf}>
					<ul
						className={cn(
							"min-h-0 divide-y overflow-y-auto md:border-r",
							reading && "hidden md:block",
						)}
					>
						{emails.map((e) => (
							<EmailRow
								key={e.id}
								email={e}
								selected={e.id === selected.id}
								onOpen={() => {
									setSelectedId(e.id);
									setReading(true);
								}}
								onMenu={() => setMenuFor(e)}
								tag={tagOf?.(e)}
							/>
						))}
					</ul>
				</ContextMenuTrigger>
				{menuOf && menuFor && (
					<ContextMenuContent>{menuOf(menuFor)}</ContextMenuContent>
				)}
			</ContextMenu>
			<div
				className={cn("flex min-h-0 flex-col", !reading && "hidden md:flex")}
			>
				<button
					type="button"
					onClick={() => setReading(false)}
					className="flex items-center gap-1 px-4 pt-3 text-muted-foreground md:hidden"
				>
					<ArrowLeft className="size-4" />
					Emails
				</button>
				<EmailReader
					key={selected.id}
					email={selected}
					box={box}
					fileUrl={fileUrl}
					className="min-h-0 flex-1 animate-in fade-in-0 slide-in-from-right-2"
					actions={actionsOf(selected)}
				/>
			</div>
		</div>
	);
}

// A tab of a mailbox's views, or of the mailboxes.
export const tabClass = (active: boolean) =>
	cn(
		"inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 font-medium",
		active
			? "bg-surface-strong text-foreground"
			: "text-muted-foreground hover:bg-surface hover:text-foreground",
	);

// How many wait in a tab, beside its name.
export function TabCount({ n }: { n: number }) {
	return <span className="text-muted-foreground tabular-nums">{n}</span>;
}
