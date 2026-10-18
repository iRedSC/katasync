// Ranks the products an unmatched listing might be selling, best first. Pure,
// so the app's picker and agents over MCP get the same guesses.

export type MatchReason =
	| "same-sku" // the listing's SKU is the product's SKU, alias, or their item number
	| "matched-before" // another listing with this title sells it
	| "part-number" // a SKU or item number of the product appears in the title
	| "same-name"
	| "similar-name";

export type Candidate = {
	productId: number;
	sku: string;
	// Every other code the product is known by: aliases and the supplier's
	// item number.
	codes: string[];
	name: string;
	variantName: string | null;
	kind: "simple" | "kit" | "bundle";
};

export type RankInput = {
	title: string;
	sku: string | null;
	// Products other listings with this title are matched to.
	matchedBefore: number[];
	// Amazon stocks physical units, so a tool set can't back an FBA listing.
	fba: boolean;
};

const SCORE: Record<MatchReason, number> = {
	"same-sku": 100,
	"matched-before": 90,
	"part-number": 80,
	"same-name": 70,
	"similar-name": 0, // plus how much of the name is shared, below
};

export function normalizeTitle(title: string) {
	return title
		.replace(/ - Default Title$/, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

const STOP = new Set(["the", "and", "for", "with", "of", "a", "to", "in"]);

function words(text: string) {
	return new Set(
		normalizeTitle(text)
			.split(" ")
			.filter((w) => w.length > 1 && !STOP.has(w)),
	);
}

// Codes too short or plain to mean anything inside a title, like "12".
function meaningfulCode(code: string) {
	return code.length >= 4 && /\d/.test(code);
}

const compact = (text: string) => normalizeTitle(text).replaceAll(" ", "");

// Whole words only: "1136" is in "1136- Level 5 screw" but not in "11365".
function containsCode(title: string, code: string) {
	return ` ${title} `.includes(` ${normalizeTitle(code)} `);
}

export function rankCandidates<C extends Candidate>(
	input: RankInput,
	catalog: C[],
	limit = 6,
): { candidate: C; reason: MatchReason }[] {
	const sku = input.sku?.trim().toLowerCase() ?? null;
	const title = normalizeTitle(input.title);
	const titleWords = words(input.title);
	const compactTitle = compact(title);
	const scored: { candidate: C; reason: MatchReason; score: number }[] = [];
	for (const c of catalog) {
		if (input.fba && c.kind === "bundle") continue;
		const codes = [c.sku, ...c.codes];
		const found: { reason: MatchReason; score: number }[] = [];
		const add = (reason: MatchReason, score = SCORE[reason]) =>
			found.push({ reason, score });
		if (sku && codes.some((code) => code.toLowerCase() === sku))
			add("same-sku");
		if (input.matchedBefore.includes(c.productId)) add("matched-before");
		if (
			codes.some(
				(code) =>
					(meaningfulCode(code) && containsCode(title, code)) ||
					compact(code) === compactTitle,
			)
		)
			add("part-number");
		const name = c.variantName ? `${c.name} ${c.variantName}` : c.name;
		if (normalizeTitle(name) === title) add("same-name");
		const nameWords = words(name);
		let shared = 0;
		for (const w of nameWords) if (titleWords.has(w)) shared++;
		const overlap = shared / Math.max(nameWords.size, titleWords.size, 1);
		if (shared >= 2 && overlap >= 0.3)
			add("similar-name", Math.round(overlap * 60));
		// Spacing aside: "Rock Splicer" is the start of "Rocksplicer Board".
		if (compactTitle.length >= 6 && compact(name).includes(compactTitle))
			add("similar-name", 40);
		const best = found.sort((a, b) => b.score - a.score)[0];
		if (best) scored.push({ candidate: c, ...best });
	}
	return scored
		.sort(
			(a, b) =>
				b.score - a.score || a.candidate.sku.localeCompare(b.candidate.sku),
		)
		.slice(0, limit)
		.map(({ candidate, reason }) => ({ candidate, reason }));
}

// Listings that are the same item: the same SKU, or with no SKU the same
// title (one item listed on Shopify and TikTok).
export function itemKey(sku: string | null, title: string) {
	const s = sku?.trim();
	return s ? `sku:${s.toLowerCase()}` : `title:${normalizeTitle(title)}`;
}
