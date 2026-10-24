/**
 * Product search ranking, from the storefront (native's
 * app/lib/searchRanking.ts) so the shop and katasync find things alike. Every
 * search in katasync runs on it: product pickers through productSearch
 * (src/lib/product-search.ts), lists through textMatcher below.
 *
 * Priority is SKU > title > description:
 *
 * 1. SKU: the query is a SKU or manufacturer part number, or the start of
 *    one, ignoring case and punctuation (`dm-05` finds DM-05DMFF, `05dmff`
 *    finds it too). Never fuzzy: a near-miss part number is a different
 *    part.
 * 2. Title: an order-free gestalt match. Shared runs of characters count
 *    wherever they sit, so word order doesn't matter and typos only cost the
 *    letters they break. Characters of the query missing from the title cost
 *    a lot; extra title characters cost a little. A tool's parts are usually
 *    titled "<tool> <part>", so they match the same and only add extra
 *    characters: the tool always ranks above its own parts.
 * 3. Description: how much of the query appears among the description's
 *    words, capped well below a good title match.
 *
 * A loose trigram filter picks candidates first, so scoring only runs on
 * items sharing a fair part of the query's letters.
 */

/** A product as search sees it. Callers can carry extra fields along. */
export type SearchProduct = {
	title: string;
	skus: readonly string[];
	/** Manufacturer part numbers; they match like SKUs. */
	partNumbers?: readonly string[];
	/** Plain text. */
	description?: string;
};

export type SearchHit<T> = {
	item: T;
	/** 0-1 within a tier. */
	score: number;
	/** Matched by SKU; these rank above everything else. */
	sku: boolean;
};

export type SearchIndex<T> = {
	entries: Entry<T>[];
	/** Trigram -> indexes into entries, from titles and SKUs. */
	titlePostings: Postings;
	/** Trigram -> indexes into entries, from descriptions. */
	descriptionPostings: Postings;
};

type Postings = Map<string, number[]>;

type Entry<T> = {
	item: T;
	title: string;
	/** SKUs and part numbers, lowercased with punctuation removed. */
	skus: string[];
	descriptionWords: string[];
};

/** Cost of a query character the title lacks. */
const MISSING_WEIGHT = 1;
/** Cost of a title character the query lacks: small, so long titles still rank. */
const EXTRA_WEIGHT = 0.15;
/** Description matches top out at half a perfect title match. */
const DESCRIPTION_WEIGHT = 0.5;
/** Hits scoring below this are noise, not results. */
const MIN_SCORE = 0.35;
/**
 * Shortest shared run that counts in a title. Two letters is too loose:
 * "ma" (master) + "kit" spells most of "makita".
 */
const TITLE_MIN_RUN = 3;
/** Within a single word two letters are fine; single letters are noise. */
const WORD_MIN_RUN = 2;
/** How alike a description word must be to a query word to count, 0-1. */
const WORD_SIMILARITY = 0.8;
/** SKU prefixes shorter than this match too much. */
const MIN_SKU_PREFIX = 3;
/** Share of the query's trigrams a candidate needs in titles or descriptions. */
const GATHER_SHARE = 1 / 3;

/** Words that carry no meaning in a description. */
const STOPWORDS = new Set(
	"a an and are as at be by for from has have in is it its of on or our that the this to was were will with you your".split(
		" ",
	),
);

/** Lowercase, accents stripped, every run of other characters one space. */
export function normalize(text: string) {
	return text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function compact(text: string) {
	return normalize(text).replace(/ /g, "");
}

/** A description's distinct meaningful words. */
function descriptionWords(text: string) {
	const words = new Set(
		normalize(text)
			.split(" ")
			.filter((word) => word && !STOPWORDS.has(word)),
	);
	return [...words];
}

/**
 * Characters `a` and `b` share in runs of at least `minRun`, in any order:
 * take the longest shared run, blank it out on both sides so it can't join
 * its neighbours, repeat.
 */
function orderFreeMatch(a: string, b: string, minRun: number) {
	return blankRuns(codes(a), codes(b), minRun);
}

function codes(text: string) {
	return Int32Array.from(text, (char) => char.charCodeAt(0));
}

/** BLANKED marks used characters of the left side; the right uses -2. */
const BLANKED = -1;

function blankRuns(left: Int32Array, right: Int32Array, minRun: number) {
	const row = new Int32Array(right.length + 1);
	let matched = 0;
	for (;;) {
		let best = 0;
		let leftAt = 0;
		let rightAt = 0;
		row.fill(0);
		for (let i = 1; i <= left.length; i++) {
			let diagonal = 0;
			for (let j = 1; j <= right.length; j++) {
				const above = row[j];
				row[j] = left[i - 1] === right[j - 1] ? diagonal + 1 : 0;
				if (row[j] > best) {
					best = row[j];
					leftAt = i - best;
					rightAt = j - best;
				}
				diagonal = above;
			}
		}
		if (best < minRun) return matched;
		left.fill(BLANKED, leftAt, leftAt + best);
		// Distinct from BLANKED so blanked characters never match each other.
		right.fill(-2, rightAt, rightAt + best);
		matched += best;
	}
}

/** How well a normalized title answers a normalized query, 0-1. */
function titleScore(query: string, title: string) {
	const left = codes(query);
	let matched = blankRuns(left, codes(title), TITLE_MIN_RUN);
	// A query word too short to make a run counts when a title word starts
	// with it: "fl" while typing "flat", "dm" in "dm 05".
	const titleWords = title.split(" ");
	let at = 0;
	for (const word of query.split(" ")) {
		if (
			word.length < TITLE_MIN_RUN &&
			!left.subarray(at, at + word.length).includes(BLANKED) &&
			titleWords.some((titleWord) => titleWord.startsWith(word))
		) {
			matched += word.length;
		}
		at += word.length + 1;
	}
	if (!matched) return 0;
	const missing = query.length - matched;
	const extra = title.length - matched;
	return matched / (matched + MISSING_WEIGHT * missing + EXTRA_WEIGHT * extra);
}

/**
 * Whether a description word stands for a query word: it starts with it
 * ("extract" while typing "extractor"), or is a near spelling. Looser than
 * this and "makita" finds "manta".
 */
function wordMatches(queryWord: string, word: string) {
	if (word === queryWord) return true;
	// "fl" mid-typing would match half the catalog's descriptions.
	if (queryWord.length < TITLE_MIN_RUN) return false;
	if (word.startsWith(queryWord)) return true;
	const minRun = Math.min(WORD_MIN_RUN, queryWord.length, word.length);
	const similarity =
		(2 * orderFreeMatch(queryWord, word, minRun)) /
		(queryWord.length + word.length);
	return similarity >= WORD_SIMILARITY;
}

/**
 * Share of the query's letters found among a description's words, 0-1.
 * `matches` memoizes wordMatches for one search: descriptions share words.
 */
function descriptionScore(
	queryWords: readonly string[],
	words: readonly string[],
	matches: Map<string, boolean>[],
) {
	let found = 0;
	let total = 0;
	queryWords.forEach((queryWord, index) => {
		const memo = matches[index];
		const isFound = words.some((word) => {
			let match = memo.get(word);
			if (match === undefined) {
				match = wordMatches(queryWord, word);
				memo.set(word, match);
			}
			return match;
		});
		if (isFound) found += queryWord.length;
		total += queryWord.length;
	});
	return total ? found / total : 0;
}

/** Trigrams of each word, padded so short words and word edges count. */
function trigrams(words: Iterable<string>, into = new Set<string>()) {
	for (const word of words) {
		const padded = ` ${word} `;
		for (let i = 0; i + 3 <= padded.length; i++) {
			into.add(padded.slice(i, i + 3));
		}
	}
	return into;
}

export function createSearchIndex<T extends SearchProduct>(
	items: readonly T[],
): SearchIndex<T> {
	const titlePostings: Postings = new Map();
	const descriptionPostings: Postings = new Map();
	const entries = items.map((item, index) => {
		const entry: Entry<T> = {
			item,
			title: normalize(item.title),
			skus: [...item.skus, ...(item.partNumbers ?? [])]
				.map(compact)
				.filter(Boolean),
			descriptionWords: item.description
				? descriptionWords(item.description)
				: [],
		};
		const titleGrams = trigrams(entry.title.split(" "));
		trigrams(entry.skus, titleGrams);
		post(titlePostings, titleGrams, index);
		post(descriptionPostings, trigrams(entry.descriptionWords), index);
		return entry;
	});
	return { entries, titlePostings, descriptionPostings };
}

function post(postings: Postings, grams: Set<string>, index: number) {
	for (const gram of grams) {
		const list = postings.get(gram);
		if (list) list.push(index);
		else postings.set(gram, [index]);
	}
}

/** Indexes sharing at least GATHER_SHARE of `grams`. Loose on purpose. */
function gather(postings: Postings, grams: Set<string>, size: number) {
	const needed = Math.max(1, Math.ceil(grams.size * GATHER_SHARE));
	const counts = new Uint16Array(size);
	const found: number[] = [];
	for (const gram of grams) {
		for (const index of postings.get(gram) ?? []) {
			if (++counts[index] === needed) found.push(index);
		}
	}
	return found;
}

/**
 * Ranked hits for `query`, best first. `prefer` lifts a kind of item above
 * the rest among title matches (parts, when picking parts); SKU matches
 * still come first.
 */
export function search<T>(
	{ entries, titlePostings, descriptionPostings }: SearchIndex<T>,
	query: string,
	{
		limit = Infinity,
		prefer,
	}: { limit?: number; prefer?: (item: T) => boolean } = {},
): SearchHit<T>[] {
	const normalized = normalize(query);
	if (!normalized) return [];
	const queryWords = normalized.split(" ");
	const queryCompact = normalized.replace(/ /g, "");
	const descriptionQuery = queryWords.filter((word) => !STOPWORDS.has(word));
	const wordMemo = descriptionQuery.map(() => new Map<string, boolean>());
	const grams = trigrams(queryWords);

	const hits: (SearchHit<T> & { title: string })[] = [];
	const seen = new Set<number>();
	const consider = (index: number, { sku = false, title = true } = {}) => {
		if (seen.has(index)) return;
		seen.add(index);
		const entry = entries[index];
		// Items gathered only by description share too little with the title
		// to be worth comparing it.
		let score = title ? titleScore(normalized, entry.title) : 0;
		// A description can't beat a title scoring above its cap.
		if (score < DESCRIPTION_WEIGHT && entry.descriptionWords.length) {
			score = Math.max(
				score,
				DESCRIPTION_WEIGHT *
					descriptionScore(descriptionQuery, entry.descriptionWords, wordMemo),
			);
		}
		if (sku || score >= MIN_SCORE) {
			hits.push({ item: entry.item, score, sku, title: entry.title });
		}
	};

	// SKU matches don't depend on gathering: `dm-05` shares few trigrams
	// with "dm05dmff" as split words.
	entries.forEach((entry, index) => {
		const isSku =
			queryCompact.length >= MIN_SKU_PREFIX
				? entry.skus.some((sku) => sku.startsWith(queryCompact))
				: entry.skus.includes(queryCompact);
		if (isSku) consider(index, { sku: true });
	});
	for (const index of gather(titlePostings, grams, entries.length)) {
		consider(index);
	}
	for (const index of gather(descriptionPostings, grams, entries.length)) {
		consider(index, { title: false });
	}

	const preferred = (hit: SearchHit<T>) => Number(prefer?.(hit.item) ?? false);
	hits.sort(
		(a, b) =>
			Number(b.sku) - Number(a.sku) ||
			preferred(b) - preferred(a) ||
			b.score - a.score ||
			a.title.length - b.title.length,
	);
	return hits
		.slice(0, limit)
		.map(({ item, score, sku }) => ({ item, score, sku }));
}

/**
 * A row's text prepared once for textMatcher: its words, and all of it run
 * together so "flatbox" finds "flat box".
 */
export type MatchText = { compact: string; words: string[] };

export function matchText(text: string): MatchText {
	const normalized = normalize(text);
	return {
		compact: normalized.replace(/ /g, ""),
		words: [...new Set(normalized.split(" ").filter(Boolean))],
	};
}

/**
 * Whether a row's text has every word of `query`: as typed anywhere in it
 * (an order number's tail, half a SKU), or, for a word of letters, a word
 * spelled nearly like it ("tapetek" for TapeTech). Words with digits are
 * never fuzzy: a near-miss number is a different one.
 */
export function textMatcher(query: string) {
	const queryWords = normalize(query).split(" ").filter(Boolean);
	const memo = queryWords.map(() => new Map<string, boolean>());
	return (text: MatchText) =>
		queryWords.every((queryWord, index) => {
			if (text.compact.includes(queryWord)) return true;
			if (/[0-9]/.test(queryWord)) return false;
			const seen = memo[index];
			return text.words.some((word) => {
				let match = seen.get(word);
				if (match === undefined) {
					match = wordMatches(queryWord, word);
					seen.set(word, match);
				}
				return match;
			});
		});
}
