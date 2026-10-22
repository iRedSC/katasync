import { Link } from "@tanstack/react-router";
import {
	ChevronDown,
	FolderInput,
	Hand,
	Plus,
	RotateCcw,
	Wand2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import type { MarketMailPage } from "#/inbox/market-mail";
import { FOLDER_NAMES, FOLDERS, type Folder } from "#/inbox/rules";
import { optimism } from "#/lib/optimism";
import { markMarketEmailImportant, moveMarketEmail } from "#/server/inbox";
import { folderIcon } from "./folders";

// Why an email sits where it does, so one sorted wrong is a click from the
// rule that did it: open that rule, start one from the email's sender, or,
// when someone moved it by hand, hand it back to the rules.

type Email = MarketMailPage["emails"][number];

const menuItem =
	"flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-strong [&_svg]:size-4 [&_svg]:text-muted-foreground";

export function WhyChip({ email: e }: { email: Email }) {
	const [open, setOpen] = useState(false);
	const { folder, important } = e.why;
	const byHand = folder === "by-hand" || important === "by-hand";
	const ruleLink = (r: { rule: number; name: string }) => (
		<Link
			to="/inbox"
			search={{ folder: "rules", rule: r.rule }}
			className="font-medium text-link hover:underline"
		>
			{r.name}
		</Link>
	);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-surface-strong hover:text-foreground"
				>
					{folder === "by-hand" ? (
						<Hand className="size-3.5 shrink-0" />
					) : (
						<Wand2 className="size-3.5 shrink-0" />
					)}
					<span className="truncate">
						{folder === "by-hand"
							? "Moved by hand"
							: folder === null
								? "No rule"
								: folder.name}
					</span>
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-72 p-1">
				<div className="space-y-1 px-2 py-1.5 text-sm">
					<p>
						In {FOLDER_NAMES[e.folder]}:{" "}
						{folder === "by-hand"
							? "moved by hand"
							: folder === null
								? "no rule moved it"
								: ruleLink(folder)}
					</p>
					{important === "by-hand" ? (
						<p>{e.important ? "Marked important" : "Unmarked"} by hand</p>
					) : (
						important.length > 0 && (
							<p>
								Important:{" "}
								{important.map((r, i) => (
									<span key={r.rule}>
										{i > 0 && ", "}
										{ruleLink(r)}
									</span>
								))}
							</p>
						)
					)}
				</div>
				<div className="border-t pt-1">
					<Link
						to="/inbox"
						search={{
							folder: "rules",
							sender: e.fromAddress,
							to: e.folder,
						}}
						className={menuItem}
					>
						<Plus />
						Rule for this sender
					</Link>
					{byHand && (
						<button
							type="button"
							className={menuItem}
							onClick={async () => {
								setOpen(false);
								await optimism.change({
									label: "Sorting it by the rules",
									patch: [],
									send: async () => {
										if (folder === "by-hand")
											await moveMarketEmail({
												data: { id: e.id, folder: null },
											});
										if (important === "by-hand")
											await markMarketEmailImportant({
												data: { id: e.id, important: null },
											});
									},
								});
							}}
						>
							<RotateCcw />
							Let the rules sort it
						</button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

// One Move button; the other folders in its menu.
export function MoveMenu({
	from,
	onMove,
}: {
	from: Folder;
	onMove: (to: Folder) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button size="sm" variant="ghost">
					<FolderInput />
					Move
					<ChevronDown className="opacity-60" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-48 p-1">
				{FOLDERS.filter((f) => f !== from).map((f) => {
					const Icon = folderIcon(f);
					return (
						<button
							key={f}
							type="button"
							onClick={() => {
								setOpen(false);
								onMove(f);
							}}
							className={menuItem}
						>
							<Icon />
							{FOLDER_NAMES[f]}
						</button>
					);
				})}
			</PopoverContent>
		</Popover>
	);
}
