import { ImageOff, Play } from "lucide-react";
import { Tip } from "#/components/ui/tooltip";
import { formatOrderDate } from "#/lib/format";
import type { OrderDetail } from "#/server/orders";

// A return's history as the marketplace keeps it: who did what when, in
// their words, with the buyer's photos and videos. A photo opens full size;
// a video opens on TikTok, whose links expire. Photos a later read no longer
// shows on any record stay, last.

type Entry = OrderDetail["returnRequests"][number]["records"][number];
type Media = Entry["media"][number];

const picture = (id: number) => `/api/return-media/${id}`;

const words = (s: string) =>
	s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ");

export function ReturnHistory({
	records,
	unlisted,
}: {
	records: Entry[];
	unlisted: Media[];
}) {
	return (
		<ol className="mt-2 flex flex-col border-l pl-3">
			{records.map((r) => (
				<li key={r.id} className="relative pb-2 last:pb-0">
					<span
						className={`absolute top-1.5 -left-[17px] size-2 rounded-full ${r.role === "BUYER" ? "bg-info-icon" : "bg-muted-foreground/40"}`}
					/>
					<div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
						{r.role && (
							<span className="font-medium text-foreground">
								{words(r.role)}
							</span>
						)}
						{r.createdAt && <span>{formatOrderDate(r.createdAt)}</span>}
					</div>
					{(r.description || r.reasonText) && (
						<p>
							{r.description}
							{r.description && r.reasonText ? ": " : ""}
							{r.reasonText}
						</p>
					)}
					{r.note && <p className="text-muted-foreground">{r.note}</p>}
					{r.media.length > 0 && (
						<div className="mt-1 flex flex-wrap gap-1.5">
							{r.media.map((m) => (
								<Thumb key={m.id} m={m} />
							))}
						</div>
					)}
				</li>
			))}
			{unlisted.length > 0 && (
				<li className="relative">
					<span className="absolute top-1.5 -left-[17px] size-2 rounded-full bg-muted-foreground/40" />
					<p className="text-xs text-muted-foreground">
						No longer on TikTok's records
					</p>
					<div className="mt-1 flex flex-wrap gap-1.5">
						{unlisted.map((m) => (
							<Thumb key={m.id} m={m} />
						))}
					</div>
				</li>
			)}
		</ol>
	);
}

const TILE =
	"relative flex size-16 items-center justify-center overflow-hidden rounded-md bg-surface-strong";

function Thumb({ m }: { m: Media }) {
	const kept = m.copy === "kept";
	// A photo that's here opens from here; otherwise TikTok's link is all
	// there is, and one that isn't TikTok's (url null) isn't opened at all.
	const href =
		m.kind === "video"
			? m.url
			: kept
				? picture(m.id)
				: m.copy === "refused"
					? null
					: m.url;
	if (href === null && !kept)
		return (
			<Tip content="Not a TikTok link">
				<span className={TILE}>
					<ImageOff className="size-5 text-muted-foreground" />
				</span>
			</Tip>
		);
	const inner = (
		<>
			{kept ? (
				<img
					src={picture(m.id)}
					alt={m.kind === "video" ? "Buyer's video" : "Buyer's photo"}
					className="size-full object-cover"
				/>
			) : m.copy === "unfetched" ? (
				<span className="size-full animate-pulse bg-muted-foreground/10" />
			) : m.copy === "gone" ? (
				<ImageOff className="size-5 text-muted-foreground" />
			) : null}
			{m.kind === "video" && (
				<Play className="absolute size-5 fill-white text-white drop-shadow" />
			)}
		</>
	);
	// A video kept by its cover, but whose own link isn't TikTok's.
	if (href === null)
		return (
			<Tip content="Not a TikTok link">
				<span className={TILE}>{inner}</span>
			</Tip>
		);
	const tile = (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className={`${TILE} hover:opacity-80`}
		>
			{inner}
		</a>
	);
	return m.copy === "gone" ? (
		<Tip content="Expired on TikTok">{tile}</Tip>
	) : (
		tile
	);
}
