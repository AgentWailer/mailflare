/**
 * Gives very long unbroken strings (a pasted link, a token, a file path) places to break.
 *
 * A message's text keeps its words whole (`overflow-wrap: break-word`). With `anywhere` on
 * everything, a table may squeeze a column down to one character, and a receipt shows its amount
 * as "$", "1", "1", "4" below each other. A long string, though, would make a table wider than a
 * phone and the whole message would be scaled down to fit. So such a string gets break
 * opportunities (`<wbr>`) every few characters, after its own punctuation where there is some. The
 * column it stands in can then shrink to a piece of it, never to a single character, and no
 * element is added that a message's own style rules could match.
 *
 * A second, quieter set of break points is for a message that would otherwise be shown too small to
 * read (`fit-email-to-width.ts`): longer ordinary words and medium-long strings may then break too.
 * They are hidden until that happens. Amounts, dates and short words get none, ever.
 */

/** From this many characters without a space on, a string with digits or punctuation in it is not a word. */
export const LONG_TOKEN_LENGTH = 30;
/**
 * A word made of letters only is left whole for longer: a break point is a place where a line does
 * break, also when the whole word would have fitted on the next line, and a long compound
 * ("Berufsunfähigkeitsversicherung") reads badly cut in the middle of running text.
 */
export const LONG_WORD_LENGTH = 45;
/** A piece between two break opportunities is at most this long; this is what a column can shrink to. */
export const LONG_TOKEN_PIECE = 12;
/** For a message too small to read: words from this length on, and other strings from the next. */
export const RELAXED_WORD_LENGTH = 9;
export const RELAXED_TOKEN_LENGTH = 13;
const RELAXED_PIECE = 7;
/** Marks the break points that only count while the message is relaxed. */
export const RELAXED_BREAK = "data-mailflare-relaxed";
/** After one of these a break reads naturally, once a piece is at least this long. */
const DELIMITERS = new Set(["-", "/", ".", "_", "?", "&", "=", "@", ":", ",", ";", "+", "%", "#", "~", "|", "\\"]);
const MIN_PIECE = 5;
const MIN_RELAXED_PIECE = 4;
/** Text nodes read; a newsletter with tens of thousands is not walked to the end. */
const MAX_TEXT_NODES = 20_000;

// `pre` keeps its own line breaks; the rest is not text to lay out.
const SKIPPED = new Set(["PRE", "TEXTAREA", "STYLE", "SCRIPT", "TITLE", "SVG", "MATH"]);

/**
 * A run that offers no place to break. Scripts written without spaces (Chinese, Japanese, Korean,
 * Thai, Lao, Khmer, Burmese) break between their own characters or words and are left alone, as are
 * a soft hyphen and a zero-width space, which are break opportunities already.
 */
function runs(from: number): RegExp {
	return new RegExp(`[^\\s\\u200b\\u00ad\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}]{${from},}`, "gu");
}

/** Letters, with punctuation at most at its ends: "(Versicherungsbedingungen)," is a word, "INV-2026" and "a.b" are not. */
const WORD = /^[^\p{L}\p{N}]*[\p{L}\p{M}]+[^\p{L}\p{N}]*$/u;

/** What the reader sees as one character: a letter with its accents, an emoji with its skin tone or its family. */
function graphemes(text: string): string[] {
	const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter;
	if (!Segmenter) return Array.from(text);
	return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
}

/**
 * Where `token` may break: after its own punctuation where a piece of reasonable length ends there,
 * else in the middle of the stretch up to the next punctuation, else after `longest` characters.
 * No piece but the last is shorter than `shortest`, so a column never shrinks to a sliver.
 */
export function splitLongToken(token: string, longest = LONG_TOKEN_PIECE, shortest = MIN_PIECE): string[] {
	const characters = graphemes(token);
	const pieces: string[] = [];
	let start = 0;
	while (characters.length - start > longest) {
		const left = characters.length - start;
		// The first punctuation that ends a piece of at least `shortest` characters, looked for two pieces ahead.
		let upTo = 0;
		for (let count = shortest; count <= Math.min(left - 1, 2 * longest); count++) {
			if (DELIMITERS.has(characters[start + count - 1]) && !DELIMITERS.has(characters[start + count])) { upTo = count; break; }
		}
		let take = longest;
		if (upTo && upTo <= longest) take = upTo;
		// Punctuation a little further on: two even pieces up to it read better than a full one and a stump.
		else if (upTo) take = Math.max(shortest, Math.ceil(upTo / 2));
		// Near the end: two halves instead of a full piece and a few leftover characters.
		else if (left < longest + shortest) take = Math.ceil(left / 2);
		pieces.push(characters.slice(start, start + take).join(""));
		start += take;
	}
	if (start < characters.length) pieces.push(characters.slice(start).join(""));
	return pieces;
}

function breakable(token: string, relaxed: boolean): boolean {
	const length = graphemes(token).length;
	const word = WORD.test(token);
	if (!relaxed) return length >= (word ? LONG_WORD_LENGTH : LONG_TOKEN_LENGTH);
	// What the first pass already broke is left alone; a number (an amount, a date) is never broken here.
	if (length >= (word ? LONG_WORD_LENGTH : LONG_TOKEN_LENGTH)) return false;
	if (word) return length >= RELAXED_WORD_LENGTH;
	// An amount with its currency (`USD1,234,567.89`, `1.234,56EUR`) and a timestamp (`2026-11-27T17:52:31Z`)
	// carry letters too: what is mostly digits is a number and stays whole.
	const letters = token.match(/\p{L}/gu)?.length ?? 0, digits = token.match(/\p{Nd}/gu)?.length ?? 0;
	return length >= RELAXED_TOKEN_LENGTH && letters > digits;
}

function insertBreaks(root: DocumentFragment | Element, relaxed: boolean): void {
	const doc = root.ownerDocument;
	if (!doc) return;
	const least = relaxed ? RELAXED_WORD_LENGTH : LONG_TOKEN_LENGTH;
	const pattern = runs(least);
	const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
	const found: Text[] = [];
	for (let read = 0, node = walker.nextNode(); node && read < MAX_TEXT_NODES; read++, node = walker.nextNode()) {
		const text = node as Text;
		if (text.data.length < least) continue;
		let skipped = false;
		for (let parent = text.parentElement; parent && !skipped; parent = parent.parentElement) skipped = SKIPPED.has(parent.tagName.toUpperCase());
		pattern.lastIndex = 0;
		if (!skipped && pattern.test(text.data)) found.push(text);
	}
	for (const text of found) {
		const pieces = doc.createDocumentFragment();
		let last = 0, changed = false;
		pattern.lastIndex = 0;
		for (let match = pattern.exec(text.data); match; match = pattern.exec(text.data)) {
			if (!breakable(match[0], relaxed)) continue;
			changed = true;
			if (match.index > last) pieces.appendChild(doc.createTextNode(text.data.slice(last, match.index)));
			const parts = relaxed ? splitLongToken(match[0], RELAXED_PIECE, MIN_RELAXED_PIECE) : splitLongToken(match[0]);
			parts.forEach((piece, index) => {
				if (index > 0) {
					const point = doc.createElement("wbr");
					if (relaxed) point.setAttribute(RELAXED_BREAK, "");
					pieces.appendChild(point);
				}
				pieces.appendChild(doc.createTextNode(piece));
			});
			last = match.index + match[0].length;
		}
		if (!changed) continue;
		if (last < text.data.length) pieces.appendChild(doc.createTextNode(text.data.slice(last)));
		text.replaceWith(pieces);
	}
}

/** Break points for strings that are no words any more. Done once, when a message is laid out. */
export function wrapLongTokens(root: DocumentFragment | Element): void {
	insertBreaks(root, false);
}

/**
 * The extra break points for a message that would otherwise be too small to read: in longer words
 * and medium-long strings. Done once, the first time that happens; they count only while the
 * message is marked relaxed (see `relaxedWrapStyle`).
 */
export function addRelaxedBreaks(root: DocumentFragment | Element): void {
	insertBreaks(root, true);
}
