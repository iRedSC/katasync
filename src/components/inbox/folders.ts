import {
	Archive,
	Bell,
	FolderCheck,
	Inbox,
	type LucideIcon,
	MessagesSquare,
	Scale,
	ShieldAlert,
	ShoppingCart,
	Star,
	Undo2,
	Voicemail,
	Wand2,
} from "lucide-react";
import { FOLDER_NAMES, FOLDERS, type Folder } from "#/inbox/rules";

// Every folder of the Inbox page, in the order the side list shows them:
// buyers' messages, the marketplaces mailbox's (Important first: a state, shown as a folder), the
// purchasing mailbox's, and the rules that sort the first.

export type MarketView = "important" | "voicemails" | Folder | "done";
export type PurchasingView = "unfiled" | "filed";
export type InboxFolder =
	| "buyers"
	| "precedents"
	| MarketView
	| PurchasingView
	| "rules";

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

// Unfiled waits on a decision; Filed holds those decided: on a PO, or set
// aside as about none.
export const PURCHASING_FOLDERS: Entry[] = [
	{ folder: "unfiled", name: "Unfiled", icon: Inbox },
	{ folder: "filed", name: "Filed", icon: FolderCheck },
];

// Conversations with buyers, answered in place.
export const BUYERS: Entry = {
	folder: "buyers",
	name: "Buyers",
	icon: MessagesSquare,
};

export const VOICEMAILS: Entry = {
	folder: "voicemails",
	name: "Voicemails",
	icon: Voicemail,
};

// What the reply agent follows.
export const PRECEDENTS: Entry = {
	folder: "precedents",
	name: "Precedents",
	icon: Scale,
};

export const RULES: Entry = { folder: "rules", name: "Rules", icon: Wand2 };

export const folderIcon = (f: Folder) => folderIcons[f];
export const isFolder = (v: unknown): v is Folder =>
	FOLDERS.includes(v as Folder);
export const isMarketView = (f: InboxFolder): f is MarketView =>
	f === "voicemails" || MARKET_FOLDERS.some((e) => e.folder === f);
export const isPurchasingView = (f: InboxFolder): f is PurchasingView =>
	PURCHASING_FOLDERS.some((e) => e.folder === f);

const ALL = [
	BUYERS,
	VOICEMAILS,
	PRECEDENTS,
	...MARKET_FOLDERS,
	...PURCHASING_FOLDERS,
	RULES,
];
export const isInboxFolder = (v: unknown): v is InboxFolder =>
	ALL.some((e) => e.folder === v);

// A purchasing folder by its name, or by a name from before Unfiled and
// Filed that links and bookmarks still use.
export const purchasingFolderOf = (v: unknown): PurchasingView | null =>
	v === "unfiled" || v === "to-file"
		? "unfiled"
		: v === "filed" || v === "set-aside" || v === "on-po"
			? "filed"
			: null;
