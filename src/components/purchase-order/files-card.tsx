import {
	Download,
	ExternalLink,
	Eye,
	FileText,
	Image,
	Loader2,
	Mail,
	Paperclip,
	Plus,
	X,
} from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { toast } from "sonner";
import {
	attachmentUrl,
	FileView,
	kb,
	shownAs,
} from "#/components/emails/reader";
import { Card } from "#/components/page";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "#/components/ui/dialog";
import { Tip } from "#/components/ui/tooltip";
import { formatDate } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { MAX_PO_FILE_BYTES } from "#/purchasing/file-limits";
import { type PurchaseOrderDetail, setPoFilesOff } from "#/server/purchasing";
import { poData } from "./po-data";

// Every file about the PO in one place: the ones put on it (dropped here or
// by Claude) and the ones its emails carry, newest first, each once. Each
// opens over the page; one the browser can't show downloads.

type Row = {
	key: string;
	id: number;
	filename: string;
	contentType: string;
	size: number;
	kept: boolean;
	url: string;
	from: string;
	at: Date;
	// Null for an email's file too large to keep: it can't be compared.
	sha256: string | null;
	// Everything this row stands for, the same file sent or added more than
	// once; removing it takes them all off the PO.
	files: number[];
	attachments: number[];
};

type Upload = { key: number; filename: string; failed: boolean };

let nextKey = 0;

function rowsOf(d: PurchaseOrderDetail): Row[] {
	const own: Row[] = d.files.map((f) => ({
		key: `f${f.id}`,
		...f,
		kept: true,
		url: `/api/po-files/${f.id}`,
		from: f.addedBy === "claude" ? "Added by Claude" : "Added",
		at: new Date(f.createdAt),
		files: [f.id],
		attachments: [],
	}));
	const emailed: Row[] = d.emails.flatMap((e) =>
		e.attachments
			.filter((a) => a.removedAt === null)
			.map((a) => ({
				key: `a${a.id}`,
				...a,
				url: attachmentUrl(a),
				from: e.fromName ?? e.fromAddress,
				at: new Date(e.receivedAt),
				files: [],
				attachments: [a.id],
			})),
	);
	// The same bytes twice (an email forwarded again, or a file added that an
	// email has) are one row: the first email's, else the first added.
	const first = [
		...emailed.sort((a, b) => a.at.getTime() - b.at.getTime()),
		...own.sort((a, b) => a.at.getTime() - b.at.getTime()),
	];
	const bySha = new Map<string, Row>();
	const rows: Row[] = [];
	for (const row of first) {
		const same = row.sha256 ? bySha.get(row.sha256) : undefined;
		if (same) {
			same.files.push(...row.files);
			same.attachments.push(...row.attachments);
			continue;
		}
		if (row.sha256) bySha.set(row.sha256, row);
		rows.push(row);
	}
	return rows.sort((a, b) => b.at.getTime() - a.at.getTime());
}

async function sha256Of(file: File) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		await file.arrayBuffer(),
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function upload(purchaseOrderId: number, file: File) {
	const form = new FormData();
	form.append("file", file);
	const res = await fetch(`/api/po-file-uploads/${purchaseOrderId}`, {
		method: "POST",
		body: form,
	}).catch(() => null);
	if (res?.ok) return;
	const body = (await res?.json().catch(() => null)) as {
		error?: string;
	} | null;
	throw new Error(
		body?.error ??
			(res ? `${file.name} didn't upload (${res.status})` : "No connection"),
	);
}

export function FilesCard({ detail: d }: { detail: PurchaseOrderDetail }) {
	const po = d.order;
	const rows = rowsOf(d);
	const [uploads, setUploads] = useState<Upload[]>([]);
	const [dragging, setDragging] = useState(false);
	const [viewing, setViewing] = useState<Row | null>(null);
	// The row a dropped file already is, lit for a moment.
	const [found, setFound] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const uploadRows = useRef(new Map<number, HTMLLIElement>());
	const fileRows = useRef(new Map<string, HTMLLIElement>());

	function point(row: Row) {
		const el = fileRows.current.get(row.key) ?? null;
		el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		shake(el);
		setFound(row.key);
		setTimeout(() => setFound((k) => (k === row.key ? null : k)), 1500);
	}

	// Red, a shake, and gone; the toast says why.
	function fail(key: number) {
		setUploads((us) =>
			us.map((u) => (u.key === key ? { ...u, failed: true } : u)),
		);
		requestAnimationFrame(() => shake(uploadRows.current.get(key) ?? null));
		setTimeout(() => setUploads((us) => us.filter((u) => u.key !== key)), 2500);
	}

	// One request a file: Vercel takes 4.5 MB a request. Each shows as it
	// goes up, and is in the list once the page has reloaded with it.
	async function add(files: File[]) {
		const shas = await Promise.all(
			files.map((f) => sha256Of(f).catch(() => null)),
		);
		for (const [i, file] of files.entries()) {
			// One the PO has is pointed at instead; the server refuses it too.
			const there = rows.find((r) => r.sha256 && r.sha256 === shas[i]);
			if (there) {
				point(there);
				toast(`${file.name} is already here`);
				continue;
			}
			const key = nextKey++;
			setUploads((us) => [...us, { key, filename: file.name, failed: false }]);
			if (file.size > MAX_PO_FILE_BYTES) {
				toast.error(
					`${file.name} is ${(file.size / 1e6).toFixed(1)} MB; up to ${MAX_PO_FILE_BYTES / 1e6} MB`,
				);
				fail(key);
				continue;
			}
			void optimism.change({ send: () => upload(po.id, file) }).then((r) => {
				if (r) setUploads((us) => us.filter((u) => u.key !== key));
				else fail(key);
			});
		}
	}

	async function remove(row: Row) {
		const ids = { files: row.files, attachments: row.attachments };
		const r = await optimism.change({
			label: `Removing ${row.filename}`,
			patch: poData.patch(po.id, (data) => ({
				...data,
				files: data.files.filter((f) => !ids.files.includes(f.id)),
				emails: data.emails.map((e) => ({
					...e,
					attachments: e.attachments.map((a) =>
						ids.attachments.includes(a.id)
							? { ...a, removedAt: new Date() }
							: a,
					),
				})),
			})),
			send: () => setPoFilesOff({ data: { ...ids, removed: true } }),
		});
		if (!r) return;
		offerUndo(`Removed ${row.filename}`, {
			undo: async () => {
				const back = await optimism.change({
					label: `Putting ${row.filename} back`,
					patch: [],
					send: () => setPoFilesOff({ data: { ...ids, removed: false } }),
				});
				return back ? `${row.filename} is back` : null;
			},
		});
	}

	const onDrag = (e: DragEvent, over: boolean) => {
		if (!e.dataTransfer.types.includes("Files")) return;
		e.preventDefault();
		setDragging(over);
	};

	const empty = rows.length === 0 && uploads.length === 0;
	return (
		<Card
			flush
			title="Files"
			aside={
				<Button
					size="sm"
					variant="ghost"
					className="-my-1 text-muted-foreground"
					onClick={() => input.current?.click()}
				>
					<Plus />
					Add
				</Button>
			}
			className={cn(
				"transition-shadow",
				dragging && "ring-2 ring-ring ring-offset-2",
			)}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; Add and the empty box are its buttons */}
			<div
				onDragEnter={(e) => onDrag(e, true)}
				onDragOver={(e) => onDrag(e, true)}
				onDragLeave={(e) => {
					if (!e.currentTarget.contains(e.relatedTarget as Node))
						setDragging(false);
				}}
				onDrop={(e) => {
					onDrag(e, false);
					if (e.dataTransfer.files.length > 0)
						void add([...e.dataTransfer.files]);
				}}
				className="pb-2"
			>
				<input
					ref={input}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						if (e.target.files) void add([...e.target.files]);
						e.target.value = "";
					}}
				/>
				{empty ? (
					<button
						type="button"
						onClick={() => input.current?.click()}
						className={cn(
							"mx-4 mb-2 flex w-[calc(100%-2rem)] items-center justify-center gap-2 rounded-lg border border-dashed py-5 text-muted-foreground transition-colors hover:bg-surface",
							dragging && "border-ring bg-surface text-foreground",
						)}
					>
						<Paperclip className="size-4" />
						Drop files here
					</button>
				) : (
					<ul>
						{uploads.map((u) => (
							<li
								key={`u${u.key}`}
								ref={(el) => {
									if (el) uploadRows.current.set(u.key, el);
									else uploadRows.current.delete(u.key);
								}}
								className={cn(
									"mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors animate-in fade-in-0",
									u.failed
										? "bg-critical-surface text-critical-text"
										: "text-muted-foreground",
								)}
							>
								{u.failed ? (
									<X className="size-4 shrink-0" />
								) : (
									<Loader2 className="size-4 shrink-0 animate-spin" />
								)}
								<span className="truncate">{u.filename}</span>
							</li>
						))}
						{rows.map((row) => (
							<FileRow
								key={row.key}
								ref={(el) => {
									if (el) fileRows.current.set(row.key, el);
									else fileRows.current.delete(row.key);
								}}
								row={row}
								found={found === row.key}
								onOpen={() => setViewing(row)}
								onRemove={() => remove(row)}
							/>
						))}
					</ul>
				)}
			</div>
			<Dialog
				open={viewing !== null}
				onOpenChange={(open) => !open && setViewing(null)}
			>
				<DialogContent className="flex h-[85vh] flex-col gap-0 p-0 sm:max-w-5xl">
					<DialogTitle className="truncate border-b px-5 py-4 pr-12 text-base">
						{viewing?.filename}
					</DialogTitle>
					<DialogDescription className="sr-only">
						{viewing?.from}
					</DialogDescription>
					{viewing && (
						<div className="min-h-0 flex-1 overflow-y-auto">
							<FileView file={viewing} url={viewing.url} />
						</div>
					)}
				</DialogContent>
			</Dialog>
		</Card>
	);
}

function download(row: Row) {
	const a = document.createElement("a");
	a.href = row.url;
	a.download = row.filename;
	a.click();
}

function FileRow({
	ref,
	row,
	found,
	onOpen,
	onRemove,
}: {
	ref: (el: HTMLLIElement | null) => void;
	row: Row;
	found: boolean;
	onOpen: () => void;
	onRemove: () => void;
}) {
	const how = shownAs(row);
	const Icon =
		how === "email"
			? Mail
			: how === "image"
				? Image
				: how === "download"
					? Download
					: FileText;
	const body = (
		<>
			<Icon className="size-4 shrink-0 text-muted-foreground" />
			<span className="min-w-0 flex-1">
				<span className="block truncate">{row.filename}</span>
				<span className="block truncate text-xs text-muted-foreground">
					{row.from} · {formatDate(row.at)} · {kb(row.size)}
				</span>
			</span>
		</>
	);
	const style =
		"flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface";
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<li
					ref={ref}
					className={cn(
						"group/file mx-2 flex items-center rounded-lg ring-ring transition-shadow animate-in fade-in-0",
						found && "ring-2",
					)}
				>
					{how === "missing" ? (
						<Tip content="Too large to keep; it's in Outlook">
							<span className={cn(style, "opacity-60 hover:bg-transparent")}>
								{body}
							</span>
						</Tip>
					) : how === "download" ? (
						<a href={row.url} className={style}>
							{body}
						</a>
					) : (
						<button type="button" onClick={onOpen} className={style}>
							{body}
						</button>
					)}
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label={`Remove ${row.filename}`}
						className="text-muted-foreground [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/file:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
						onClick={onRemove}
					>
						<X />
					</Button>
				</li>
			</ContextMenuTrigger>
			<ContextMenuContent>
				{how !== "missing" && how !== "download" && (
					<ContextMenuItem onSelect={onOpen}>
						<Eye />
						Open
					</ContextMenuItem>
				)}
				{(how === "pdf" || how === "image") && (
					<ContextMenuItem onSelect={() => window.open(row.url, "_blank")}>
						<ExternalLink />
						Open in new tab
					</ContextMenuItem>
				)}
				{how !== "missing" && (
					<ContextMenuItem onSelect={() => download(row)}>
						<Download />
						Download
					</ContextMenuItem>
				)}
				{how !== "missing" && <ContextMenuSeparator />}
				<ContextMenuItem
					onSelect={onRemove}
					className="text-critical-text [&_svg]:text-critical-text"
				>
					<X />
					Remove from PO
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
