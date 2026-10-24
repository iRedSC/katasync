import type { Market } from "#/markets/market";

// What each marketplace lets a reply carry, shared by the reply box (which
// refuses a file before uploading it) and the server (which refuses a reply
// before sending it). From each one's own rules:
//   Amazon: PDF, JPG, PNG; five at most; the whole email within 10 MB
//     (encoding grows files by a third, so 7 MB of files).
//   eBay: pictures, PDF, Word, text; five at most; 2,000 characters.
//   TikTok: pictures (JPG, PNG, GIF, WEBP), each sent as its own message;
//     2,000 characters.
// Shopify has no buyer messages here.

// What a request may carry to katasync on Vercel (4.5 MB), with room to
// spare; pictures are shrunk below it before they go.
export const MAX_FILE_BYTES = 4_400_000;

type Rules = {
	// Content type to the marketplace's own kind for it.
	types: Record<string, string>;
	maxFiles: number;
	maxTotalBytes: number;
	maxChars: number | null;
	// How the reply box names what it takes, when it refuses one.
	takes: string;
};

const IMAGES = {
	"image/jpeg": "IMAGE",
	"image/png": "IMAGE",
	"image/gif": "IMAGE",
	"image/webp": "IMAGE",
};

export const ATTACHMENT_RULES: Record<Exclude<Market, "shopify">, Rules> = {
	amazon: {
		types: {
			"application/pdf": "PDF",
			"image/jpeg": "IMAGE",
			"image/png": "IMAGE",
		},
		maxFiles: 5,
		maxTotalBytes: 7_000_000,
		maxChars: null,
		takes: "PDF, JPG, PNG",
	},
	ebay: {
		types: {
			...IMAGES,
			"application/pdf": "PDF",
			"application/msword": "DOC",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
				"DOC",
			"text/plain": "TXT",
		},
		maxFiles: 5,
		maxTotalBytes: 5 * MAX_FILE_BYTES,
		maxChars: 2000,
		takes: "pictures, PDF, Word, text",
	},
	tiktok: {
		types: IMAGES,
		maxFiles: 5,
		maxTotalBytes: 5 * MAX_FILE_BYTES,
		maxChars: 2000,
		takes: "pictures",
	},
};

export function rulesFor(market: Market) {
	return market === "shopify" ? null : ATTACHMENT_RULES[market];
}

export type AttachmentFile = { name: string; type: string; size: number };

// Why these files can't go with a reply on this marketplace, or null when
// they can.
export function refuseFiles(
	market: Market,
	files: AttachmentFile[],
): string | null {
	if (files.length === 0) return null;
	const rules = rulesFor(market);
	if (!rules) return "This marketplace takes no files";
	const wrong = files.find((f) => !(f.type in rules.types));
	if (wrong) return `Takes ${rules.takes}`;
	const big = files.find((f) => f.size > MAX_FILE_BYTES);
	if (big) return `${big.name} is over ${MAX_FILE_BYTES / 1e6} MB`;
	if (files.length > rules.maxFiles) return `${rules.maxFiles} files at most`;
	const total = files.reduce((n, f) => n + f.size, 0);
	if (total > rules.maxTotalBytes)
		return `${rules.maxTotalBytes / 1e6} MB of files at most`;
	return null;
}

// Why these words can't go, or null.
export function refuseWords(market: Market, words: string): string | null {
	const max = rulesFor(market)?.maxChars ?? null;
	return max !== null && words.length > max
		? `${max.toLocaleString()} characters at most`
		: null;
}
