import {
	Archive,
	Bell,
	FileQuestion,
	FolderCheck,
	Inbox,
	type LucideIcon,
	MessagesSquare,
	ShieldAlert,
	ShoppingCart,
	Star,
	Undo2,
	Wand2,
} from "lucide-react";
import { FOLDER_NAMES, FOLDERS, type Folder } from "#/inbox/rules";

// Every folder of the Inbox page, in the order the side list shows them:
// buyers' messages, the marketplaces mailbox's (Important first: a state, shown as a folder), the
// purchasing mailbox's, and the rules that sort the first.

export type MarketView = "important" | Folder | "done";
export type PurchasingView = "to-file" | "set-aside" | "on-po";
export type InboxFolder = "buyers" | MarketView | PurchasingView | "rules";

type Entry = { folder: InboxFolder; name: string; icon: LucideIcon };

const folderIcons: Record<Folder, LucideIcon> = {
	violations: ShieldAlert,
	orders: ShoppingCart,
	returns: Undo2,
	updates: Bell,
};

export const MARKET_FOLDERS: Entry[] = [
	{ folder: "important", name: "Important", icon: Star },
	...(["violations", "orders", "returns", "updates"] as const).map((f) => ({
		folder: f,
		name: FOLDER_NAMES[f],
		icon: folderIcons[f],
	})),
	{ folder: "done", name: "Done", icon: Archive },
];

export const PURCHASING_FOLDERS: Entry[] = [
	{ folder: "to-file", name: "To file", icon: Inbox },
	{ folder: "set-aside", name: "Set aside", icon: FileQuestion },
	{ folder: "on-po", name: "On a PO", icon: FolderCheck },
];

// Conversations with buyers, answered in place.
export const BUYERS: Entry = {
	folder: "buyers",
	name: "Buyers",
	icon: MessagesSquare,
};

export const RULES: Entry = { folder: "rules", name: "Rules", icon: Wand2 };

export const folderIcon = (f: Folder) => folderIcons[f];
export const isFolder = (v: unknown): v is Folder =>
	FOLDERS.includes(v as Folder);
export const isMarketView = (f: InboxFolder): f is MarketView =>
	MARKET_FOLDERS.some((e) => e.folder === f);
export const isPurchasingView = (f: InboxFolder): f is PurchasingView =>
	PURCHASING_FOLDERS.some((e) => e.folder === f);

const ALL = [BUYERS, ...MARKET_FOLDERS, ...PURCHASING_FOLDERS, RULES];
export const isInboxFolder = (v: unknown): v is InboxFolder =>
	ALL.some((e) => e.folder === v);

// The purchasing mailbox's own name for a view.
export const purchasingView = (f: PurchasingView) =>
	f === "on-po" ? ("filed" as const) : f;
