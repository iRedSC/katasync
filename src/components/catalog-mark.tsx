import { cn } from "#/lib/utils";

const SIZES = {
	xs: "size-4 rounded text-[0.5rem]",
	sm: "size-6 rounded-md text-[0.625rem]",
	md: "size-10 rounded-lg text-sm",
	lg: "size-20 rounded-xl text-2xl",
} as const;

// Hues for catalogs without a photo, picked by name so one keeps its color
// wherever it shows.
const HUES = [210, 150, 30, 280, 350, 180, 60, 250];

export const catalogPhotoUrl = (photoId: number) =>
	`/purchasing/catalog-photo/${photoId}`;

// A catalog's photo, or its initials on a color of its own, so a catalog
// is recognised before its name is read.
export function CatalogMark({
	catalog,
	size = "sm",
	className,
}: {
	catalog: { name: string; photoId: number | null };
	size?: keyof typeof SIZES;
	className?: string;
}) {
	const box = cn("shrink-0 border", SIZES[size], className);
	if (catalog.photoId !== null)
		return (
			<img
				src={catalogPhotoUrl(catalog.photoId)}
				alt=""
				loading="lazy"
				className={cn(box, "bg-white object-cover")}
			/>
		);
	let hash = 0;
	for (const c of catalog.name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
	const hue = HUES[Math.abs(hash) % HUES.length];
	const initials = catalog.name
		.split(/\s+/)
		.filter((w) => /\w/.test(w))
		.slice(0, 2)
		.map((w) => w[0].toUpperCase())
		.join("");
	return (
		<span
			aria-hidden
			style={{
				backgroundColor: `oklch(0.95 0.04 ${hue})`,
				color: `oklch(0.45 0.1 ${hue})`,
				borderColor: `oklch(0.88 0.05 ${hue})`,
			}}
			className={cn(
				box,
				"inline-flex items-center justify-center font-semibold",
				size === "xs" && "border-0",
			)}
		>
			{size === "xs" ? initials.slice(0, 1) : initials}
		</span>
	);
}
