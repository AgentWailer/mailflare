/**
 * Lets only very long unbroken strings (a pasted link, a token, a file path) break anywhere.
 *
 * A message's text keeps its words whole (`overflow-wrap: break-word`): with `anywhere` on everything,
 * a table may squeeze a column down to one character, and a receipt shows its amount as "$", "1",
 * "1", "4" below each other. A long string, though, would make a table wider than a phone and the
 * whole message would be scaled down to fit. So those strings alone are wrapped in an element that
 * may break anywhere, which also lets the column they stand in shrink.
 */

/** From this many characters without a space on, a string is not a word any more. */
export const LONG_TOKEN_LENGTH = 30;
/** Text nodes read; a newsletter with tens of thousands is not walked to the end. */
const MAX_TEXT_NODES = 20_000;
export const LONG_TOKEN_TAG = "mailflare-token";
/** The rule that goes with the tag, for the style sheet of the shadow root the message is shown in. */
export const LONG_TOKEN_STYLE = `${LONG_TOKEN_TAG}{overflow-wrap:anywhere}`;

const SKIPPED = new Set(["PRE", "CODE", "TEXTAREA", "STYLE", "SCRIPT", "TITLE", "SVG", "MATH", LONG_TOKEN_TAG.toUpperCase()]);

export function wrapLongTokens(root: DocumentFragment | Element): void {
	const doc = root.ownerDocument;
	if (!doc) return;
	const pattern = new RegExp(`[^\\s\\u200b]{${LONG_TOKEN_LENGTH},}`, "g");
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
			const token = doc.createElement(LONG_TOKEN_TAG);
			token.textContent = match[0];
			pieces.appendChild(token);
			last = match.index + match[0].length;
		}
		if (last < text.data.length) pieces.appendChild(doc.createTextNode(text.data.slice(last)));
		text.replaceWith(pieces);
	}
}
