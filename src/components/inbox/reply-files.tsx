import {
	CircleAlert,
	LoaderCircle,
	Paperclip,
	RotateCw,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	type AttachmentFile,
	MAX_FILE_BYTES,
	type ReplyFile,
	refuseFiles,
	rulesFor,
} from "#/buyers/attachments";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { shrinkPhoto } from "#/lib/photo";
import { cn } from "#/lib/utils";
import type { Market } from "#/markets/market";

// Files on a reply before it's sent: picked, pasted, or dropped, checked
// against what the marketplace takes, and uploaded at once, so sending only
// names them. Each is uploading, ready (with its file), or failed.

type Attached = AttachmentFile & {
	key: string;
	// What the chip shows: the picture itself, before and after it's up.
	preview: string | null;
	kind: string;
} & (
		| { state: "uploading"; blob: Blob }
		| { state: "ready"; fileId: number }
		| { state: "failed"; blob: Blob; error: string }
	);

async function upload(blob: Blob, name: string) {
	const res = await fetch(
		`/api/buyer-file-uploads?name=${encodeURIComponent(name)}`,
		{
			method: "POST",
			headers: { "Content-Type": blob.type },
			body: blob,
		},
	).catch(() => null);
	const body = (await res?.json().catch(() => null)) as {
		id?: number;
		error?: string;
	} | null;
	if (res?.ok && body?.id) return body.id;
	throw new Error(body?.error ?? (res ? res.statusText : "No connection"));
}

// A picture too big to upload is shrunk to a JPEG; a GIF would lose its
// motion, so it's left to be refused.
async function fitted(file: File) {
	if (
		file.size <= MAX_FILE_BYTES ||
		!file.type.startsWith("image/") ||
		file.type === "image/gif"
	)
		return file;
	const blob = await shrinkPhoto(file).catch(() => file);
	const name = file.name.replace(/\.[^.]+$/, "") || "photo";
	return new File([blob], `${name}.jpg`, { type: blob.type });
}

export function useReplyFiles(market: Market, onRefuse: (why: string) => void) {
	const [items, setItems] = useState<Attached[]>([]);
	const rules = rulesFor(market);
	// The files as they are right now. Every change goes through `change`, so
	// an addition that waited on a photo being shrunk checks against what's
	// there when it lands, not what was on screen when it began.
	const current = useRef<Attached[]>(items);
	// The picture URLs made here, to release; a restored file's is the
	// server's, which is never ours to revoke.
	const made = useRef(new Set<string>());
	const change = (fn: (all: Attached[]) => Attached[]) => {
		current.current = fn(current.current);
		setItems(current.current);
	};
	const release = (gone: Attached[]) => {
		for (const a of gone)
			if (a.preview && made.current.delete(a.preview))
				URL.revokeObjectURL(a.preview);
	};
	const patch = (key: string, next: Partial<Attached>) =>
		change((all) =>
			all.map((a) => (a.key === key ? ({ ...a, ...next } as Attached) : a)),
		);
	const start = (a: Attached & { blob: Blob }) =>
		upload(a.blob, a.name).then(
			(fileId) => patch(a.key, { state: "ready", fileId }),
			(error: unknown) =>
				patch(a.key, {
					state: "failed",
					error: error instanceof Error ? error.message : String(error),
				}),
		);
	// Previews are released when the box is.
	useEffect(() => {
		const owned = made.current;
		return () => {
			for (const url of owned) URL.revokeObjectURL(url);
			owned.clear();
		};
	}, []);

	async function add(files: File[]) {
		if (files.length === 0) return;
		const ready = await Promise.all(files.map(fitted));
		// Checked and added with nothing awaited between, against the files
		// there now, so two additions at once can't both fit the last place.
		const why = refuseFiles(market, [...current.current, ...ready]);
		if (why) return onRefuse(why);
		const added = ready.map((f): Attached & { blob: Blob } => {
			const preview = f.type.startsWith("image/")
				? URL.createObjectURL(f)
				: null;
			if (preview) made.current.add(preview);
			return {
				key: crypto.randomUUID(),
				name: f.name || "file",
				type: f.type,
				size: f.size,
				kind: rules?.types[f.type] ?? "FILE",
				preview,
				state: "uploading",
				blob: f,
			};
		});
		change((all) => [...all, ...added]);
		for (const a of added) void start(a);
	}

	return {
		items,
		accept: Object.keys(rules?.types ?? {}).join(","),
		takesFiles: rules !== null,
		add,
		remove: (key: string) => {
			release(current.current.filter((a) => a.key === key));
			change((all) => all.filter((a) => a.key !== key));
		},
		retry: (key: string) => {
			const a = current.current.find((x) => x.key === key);
			if (a?.state !== "failed") return;
			patch(key, { state: "uploading" });
			void start({ ...a, state: "uploading" });
		},
		busy: items.some((a) => a.state !== "ready"),
		// What goes with the reply; only once every file is up.
		media: (): ReplyFile[] =>
			items.flatMap((a) =>
				a.state === "ready"
					? [
							{
								kind: a.kind,
								name: a.name,
								type: a.type,
								size: a.size,
								url: `/api/buyer-files/${a.fileId}`,
								fileId: a.fileId,
							},
						]
					: [],
			),
		// Files a reply took back (undo), already up, added to any already
		// here. Refused, like any addition, when they wouldn't all fit.
		restore: (files: ReplyFile[]) => {
			const back = files.map(
				(f): Attached => ({
					...f,
					key: crypto.randomUUID(),
					preview: f.kind === "IMAGE" ? f.url : null,
					state: "ready",
				}),
			);
			const why = refuseFiles(market, [...current.current, ...back]);
			if (why) {
				onRefuse(why);
				return false;
			}
			change((all) => [...all, ...back]);
			return true;
		},
		clear: () => {
			release(current.current);
			change(() => []);
		},
	};
}

export type ReplyFiles = ReturnType<typeof useReplyFiles>;

// The files on a reply, each removable; one that failed to upload says why
// and tries again on a click.
export function AttachedFiles({ files }: { files: ReplyFiles }) {
	if (files.items.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5 px-2 pt-2">
			{files.items.map((a) => (
				<span
					key={a.key}
					className={cn(
						"group relative flex h-14 items-center overflow-hidden rounded-md ring-1 ring-border animate-in fade-in-0 zoom-in-95",
						a.state === "failed" && "ring-critical-text",
					)}
				>
					{a.preview ? (
						<img
							src={a.preview}
							alt={a.name}
							className={cn(
								"h-full w-auto max-w-24 object-cover",
								a.state === "uploading" && "opacity-50",
							)}
						/>
					) : (
						<span className="flex max-w-40 items-center gap-1 px-2 text-sm">
							<Paperclip className="size-3.5 shrink-0" />
							<span className="truncate">{a.name}</span>
						</span>
					)}
					{a.state === "uploading" && (
						<LoaderCircle className="absolute inset-0 m-auto size-4 animate-spin" />
					)}
					{a.state === "failed" && (
						<Tip content={`${a.error}. Click to try again`}>
							<button
								type="button"
								aria-label="Upload again"
								onClick={() => files.retry(a.key)}
								className="absolute inset-0 flex items-center justify-center bg-critical-surface/80 text-critical-text"
							>
								<CircleAlert className="size-4 group-hover:hidden" />
								<RotateCw className="hidden size-4 group-hover:block" />
							</button>
						</Tip>
					)}
					<button
						type="button"
						aria-label={`Remove ${a.name}`}
						onClick={() => files.remove(a.key)}
						className="absolute top-0.5 right-0.5 rounded-full bg-background/90 p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
					>
						<X className="size-3" />
					</button>
				</span>
			))}
		</div>
	);
}

// The paperclip: picks files of the kinds this marketplace takes.
export function AttachButton({ files }: { files: ReplyFiles }) {
	const input = useRef<HTMLInputElement>(null);
	if (!files.takesFiles) return null;
	return (
		<>
			<input
				ref={input}
				type="file"
				multiple
				accept={files.accept}
				className="hidden"
				onChange={(e) => {
					void files.add([...(e.target.files ?? [])]);
					e.target.value = "";
				}}
			/>
			<Tip content="Attach (or paste, or drop)">
				<Button
					type="button"
					variant="ghost"
					aria-label="Attach"
					onClick={() => input.current?.click()}
				>
					<Paperclip />
				</Button>
			</Tip>
		</>
	);
}
