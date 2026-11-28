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
 */

/** From this many characters without a space on, a string is not a word any more. */
export const LONG_TOKEN_LENGTH = 30;
/** A piece between two break opportunities is at most this long; this is what a column can shrink to. */
export const LONG_TOKEN_PIECE = 12;
/** After one of these a break reads naturally, once a piece is at least this long. */
const DELIMITERS = new Set(["-", "/", ".", "_", "?", "&", "=", "@", ":", ",", ";", "+", "%", "#", "~", "|", "\\"]);
const MIN_PIECE = 5;
/** Text nodes read; a newsletter with tens of thousands is not walked to the end. */
const MAX_TEXT_NODES = 20_000;

// `pre` keeps its own line breaks; the rest is not text to lay out.
const SKIPPED = new Set(["PRE", "TEXTAREA", "STYLE", "SCRIPT", "TITLE", "SVG", "MATH"]);

/**
 * A run that offers no place to break. Scripts written without spaces (Chinese, Japanese, Korean,
 * Thai, Lao, Khmer, Burmese) break between their own characters or words and are left alone, as are
 * a soft hyphen and a zero-width space, which are break opportunities already.
 */
function longRuns(): RegExp {
	return new RegExp(`[^\\s\\u200b\\u00ad\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}]{${LONG_TOKEN_LENGTH},}`, "gu");
}

/**
 * Where `token` may break: after its own punctuation where a piece of reasonable length ends there,
 * else in the middle of the stretch up to the next punctuation, else after `LONG_TOKEN_PIECE`
 * characters. No piece but the last is shorter than `MIN_PIECE`, so a column never shrinks to a sliver.
 */
export function splitLongToken(token: string): string[] {
	const characters = Array.from(token);
	const pieces: string[] = [];
	let start = 0;
	while (characters.length - start > LONG_TOKEN_PIECE) {
		const left = characters.length - start;
		// The first punctuation that ends a piece of at least MIN_PIECE characters, looked for two pieces ahead.
		let upTo = 0;
		for (let count = MIN_PIECE; count <= Math.min(left - 1, 2 * LONG_TOKEN_PIECE); count++) {
			if (DELIMITERS.has(characters[start + count - 1]) && !DELIMITERS.has(characters[start + count])) { upTo = count; break; }
		}
		let take = LONG_TOKEN_PIECE;
		if (upTo && upTo <= LONG_TOKEN_PIECE) take = upTo;
		// Punctuation a little further on: two even pieces up to it read better than a full one and a stump.
		else if (upTo) take = Math.max(MIN_PIECE, Math.ceil(upTo / 2));
		// Near the end: two halves instead of a full piece and a few leftover characters.
		else if (left < LONG_TOKEN_PIECE + MIN_PIECE) take = Math.ceil(left / 2);
		pieces.push(characters.slice(start, start + take).join(""));
		start += take;
	}
	if (start < characters.length) pieces.push(characters.slice(start).join(""));
	return pieces;
}

export function wrapLongTokens(root: DocumentFragment | Element): void {
	const doc = root.ownerDocument;
	if (!doc) return;
	const pattern = longRuns();
	const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
	const found: Text[] = [];
	for (let read = 0, node = walker.nextNode(); node && read < MAX_TEXT_NODES; read++, node = walker.nextNode()) {
		const text = node as Text;
		if (text.data.length < LONG_TOKEN_LENGTH) continue;
		let skipped = false;
		for (let parent = text.parentElement; parent && !skipped; parent = parent.parentElement) skipped = SKIPPED.has(parent.tagName.toUpperCase());
		pattern.lastIndex = 0;
		if (!skipped && pattern.test(text.data)) found.push(text);
	}
	for (const text of found) {
		const pieces = doc.createDocumentFragment();
		let last = 0;
		pattern.lastIndex = 0;
		for (let match = pattern.exec(text.data); match; match = pattern.exec(text.data)) {
			if (match.index > last) pieces.appendChild(doc.createTextNode(text.data.slice(last, match.index)));
			splitLongToken(match[0]).forEach((piece, index) => {
				if (index > 0) pieces.appendChild(doc.createElement("wbr"));
				pieces.appendChild(doc.createTextNode(piece));
			});
			last = match.index + match[0].length;
		}
		if (last < text.data.length) pieces.appendChild(doc.createTextNode(text.data.slice(last)));
		text.replaceWith(pieces);
	}
}
