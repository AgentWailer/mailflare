// Very long unbroken strings in a message get places to break; ordinary words and amounts stay whole.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const bundle = await build({ entryPoints: ["src/components/messages/long-tokens.ts"], bundle: true, write: false, platform: "browser", format: "esm", tsconfig: "tsconfig.json" });
const { wrapLongTokens, addRelaxedBreaks, splitLongToken, LONG_TOKEN_LENGTH, LONG_WORD_LENGTH, LONG_TOKEN_PIECE, RELAXED_BREAK } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function wrap(html) {
	const template = dom.window.document.createElement("template");
	template.innerHTML = html;
	wrapLongTokens(template.content);
	return template;
}
const breaks = (node) => node.querySelectorAll("wbr").length;
/** The pieces a browser may lay out separately: the text between break opportunities. */
const pieces = (node) => [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.data);
const link = "https://example.com/confirm/8f2c1a9e7b6d4c3f2a1b0e9d8c7f6a5b4c3d2e1f";

test("a receipt's amounts, dates and words are left exactly as they are", () => {
	const html = '<table><tr><td>Obsidian Sync yearly subscription (Plus 10 GB plan)</td><td align="right">$114.24</td></tr><tr><td>November 27, 2026 at 5:52:31 PM EST</td><td>American Express - 1002</td></tr></table>';
	const template = wrap(html);
	assert.equal(breaks(template.content), 0);
	assert.equal(template.innerHTML, html.replace("<table>", "<table><tbody>").replace("</table>", "</tbody></table>"));
});

test("a long link gets break points where it stands; no character, attribute or element is added to it", () => {
	const template = wrap(`<p>Bitte hier bestätigen: ${link} Danke!</p><p><a href="${link}">${link}</a></p>`);
	const [first, second] = template.content.querySelectorAll("p");
	assert.equal(first.textContent, `Bitte hier bestätigen: ${link} Danke!`, "the text reads the same");
	assert(breaks(first) >= 4);
	assert.equal(first.firstChild.data, "Bitte hier bestätigen: ");
	assert.equal(first.lastChild.data.endsWith(" Danke!"), true);
	assert.equal(second.querySelector("a").getAttribute("href"), link, "the link still leads where it led");
	assert.equal(second.querySelector("a").textContent, link);
	assert.deepEqual([...template.content.querySelectorAll("*")].map((node) => node.tagName).filter((tag) => !["P", "A", "WBR"].includes(tag)), [], "nothing a message's own style rules could match is added");
});

test("no piece between two break points is longer than a column should have to be, and none is a single character", () => {
	for (const token of [link, "x".repeat(200), "a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q.r.s.t.u.v.w.x.y.z", "INV-2026-11-27-OBSIDIAN-SYNC-0001", "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"]) {
		const split = splitLongToken(token);
		assert.equal(split.join(""), token);
		assert(split.every((piece) => Array.from(piece).length <= LONG_TOKEN_PIECE), `${token}: ${JSON.stringify(split)}`);
		assert(split.slice(0, -1).every((piece) => Array.from(piece).length >= 5), `${token}: no tiny piece a column could shrink to: ${JSON.stringify(split)}`);
	}
	// A break after the string's own punctuation is preferred to one in the middle of a part.
	assert.deepEqual(splitLongToken("Versicherungsbedingungen-Kettenschloss").filter((piece) => piece.endsWith("-")).length, 1);
	assert.deepEqual(splitLongToken("https://example.com/confirm/abcdef").slice(0, 3), ["https://", "example.", "com/confirm/"]);
	assert.deepEqual(splitLongToken("😀".repeat(30)).every((piece) => !/[\ud800-\udbff]$/.test(piece)), true, "a character made of two code units is never cut in half");
});

test("the limit is a length no ordinary word reaches, counted between spaces of any kind", () => {
	const just = "x1".repeat(LONG_TOKEN_LENGTH / 2), under = just.slice(1);
	assert.equal(breaks(wrap(`<p>${under}</p>`).content), 0);
	assert(breaks(wrap(`<p>${just}</p>`).content) > 0);
	assert.equal(breaks(wrap("<p>Versicherungsbedingungen und Rechtsschutzversicherung 1.264,98&nbsp;€</p>").content), 0, "ordinary long words and amounts stay whole");
	assert.equal(breaks(wrap(`<p>${under}\u00a0${under}\u200b${under}\u00ad${under}</p>`).content), 0, "a no-break space, a zero-width space and a soft hyphen end a string");
});

test("a word made of letters is left whole far longer than a link or a number", () => {
	// A break point is where a line does break, also when the word would have fitted on the next line.
	for (const word of ["Berufsunfähigkeitsversicherung", "Arbeitsunfähigkeitsbescheinigung", "Donaudampfschifffahrtsgesellschaft", "(Rechtsschutzversicherungsgesellschaften),"]) {
		assert(Array.from(word).length >= LONG_TOKEN_LENGTH && Array.from(word).length < LONG_WORD_LENGTH);
		assert.equal(breaks(wrap(`<p>Die ${word} zahlt.</p>`).content), 0, word);
	}
	assert(breaks(wrap(`<p>${"Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz"}</p>`).content) > 0, "a word no line can hold still breaks");
	assert(breaks(wrap("<p>Berufsunfaehigkeitsversicherung-2026-11</p>").content) > 0, "with digits in it, it is an identifier");
});

test("what the reader sees as one character is never cut: accents written apart, emoji with a skin tone or a family", () => {
	assert.deepEqual(splitLongToken("aaaaaaaaaaaa\u0301bbbbbbbbbbbbbbbbbb").some((piece) => /^\p{M}/u.test(piece)), false, "no piece starts with a detached accent");
	const thumbs = "👍🏽".repeat(19), families = "👨‍👩‍👧‍👦".repeat(8);
	for (const piece of [...splitLongToken(`${thumbs}1`), ...splitLongToken(`${families}1`)]) {
		assert.doesNotMatch(piece, /^[\u{1F3FB}-\u{1F3FF}\u200d]/u, "no piece starts with a skin tone or a joiner");
		assert.doesNotMatch(piece, /\u200d$/u);
	}
	assert.equal(splitLongToken(`${thumbs}1`).join(""), `${thumbs}1`);
});

test("the extra break points for a message too small to read are for longer words, never for amounts, dates or short words", () => {
	const statement = '<table><tr><th>Buchungstag</th><th>Wertstellung</th><th>Verwendungszweck</th><th>Betrag</th></tr><tr><td>27.11.2026</td><td>27.11.2026</td><td>Lastschrift Stadtwerke Beispielstadt</td><td>1.264,98&nbsp;€</td><td>-84,20 €</td><td>INV-2026-0001</td><td>DE89370400440532013000</td></tr></table>';
	const template = wrap(statement);
	assert.equal(breaks(template.content), 0, "nothing here is a long string");
	addRelaxedBreaks(template.content);
	const cells = [...template.content.querySelectorAll("th,td")];
	const broken = cells.filter((cell) => breaks(cell) > 0).map((cell) => cell.textContent);
	// Longer words only. What is mostly digits (an invoice number, an IBAN) is a number and stays whole, like the dates and both amounts.
	assert.deepEqual(broken, ["Buchungstag", "Wertstellung", "Verwendungszweck", "Lastschrift Stadtwerke Beispielstadt"]);
	// An IBAN is compared digit by digit and stays in one piece, also one long enough to count as a long string.
	const iban = wrap("<p>IBAN MT84MALT011000012345MTLCAST001S, Verwendungszweck</p>");
	assert.equal(breaks(iban.content), 0);
	addRelaxedBreaks(iban.content);
	assert.equal(iban.content.querySelector("p").innerHTML.includes("MT84MALT011000012345MTLCAST001S"), true);
	// An amount glued to its currency and a timestamp carry letters and are numbers all the same; a name with a few digits is not.
	const glued = wrap("<table><tr><td>USD1,234,567.89</td><td>1.234.567,89EUR</td><td>CHF1'234'567.89</td><td>2026-11-27T17:52:31Z</td><td>Kundenportal-Zugang2026</td></tr></table>");
	addRelaxedBreaks(glued.content);
	assert.deepEqual([...glued.content.querySelectorAll("td")].filter((cell) => breaks(cell) > 0).map((cell) => cell.textContent), ["Kundenportal-Zugang2026"]);
	for (const whole of ["27.11.2026", "1.264,98\u00a0€", "-84,20 €"]) assert.equal(breaks(cells.find((cell) => cell.textContent === whole)), 0, whole);
	assert([...template.content.querySelectorAll("wbr")].every((point) => point.hasAttribute(RELAXED_BREAK)), "each is marked, so it counts only while the message is relaxed");
	assert.equal(template.content.textContent, wrap(statement).content.textContent, "the text reads the same");
	// Applied to a message that already has break points in a link, the link keeps its own and gets no second set.
	const mixed = wrap(`<p>${link} Verwendungszweck</p>`);
	const before = breaks(mixed.content);
	addRelaxedBreaks(mixed.content);
	assert.equal(mixed.content.querySelectorAll(`wbr:not([${RELAXED_BREAK}])`).length, before);
	assert.equal(mixed.content.querySelectorAll(`wbr[${RELAXED_BREAK}]`).length, 2);
});

test("writing without spaces between words is left to break as that script breaks", () => {
	for (const text of ["合計金額は¥12,800です。お支払いありがとうございます。領収書を保管ください。", "这是一个没有空格的很长的中文句子用来测试换行是否保持自然不会被拆成单个字符。", "ขอบคุณสำหรับการชำระเงินของคุณใบเสร็จรับเงินนี้เป็นหลักฐานการชำระเงินกรุณาเก็บไว้", "결제해주셔서감사합니다이영수증은결제증빙자료이므로보관해주시기바랍니다감사합니다"]) {
		assert(Array.from(text).length >= LONG_TOKEN_LENGTH);
		assert.equal(breaks(wrap(`<table><tr><td>${text}</td></tr></table>`).content), 0, text);
	}
});

test("inline code gets break points, a preformatted block does not, and a second pass changes nothing", () => {
	const template = wrap(`<pre>${link}</pre><p>Ihr Schlüssel: <code>${link}</code></p><style>.a{background:url(${link})}</style>`);
	assert.equal(breaks(template.content.querySelector("pre")), 0);
	assert(breaks(template.content.querySelector("code")) > 0, "a long string in inline code would otherwise widen the whole message");
	assert.equal(template.content.querySelector("style").textContent.includes(link), true);
	const once = template.innerHTML;
	wrapLongTokens(template.content);
	assert.equal(template.innerHTML, once);
	assert.deepEqual(pieces(template.content.querySelector("code")).join(""), link);
});

test("markup in a long string stays text, and a huge message is read in bounded time", () => {
	const hostile = `${"a".repeat(40)}<img src=x onerror=alert(1)>`;
	const template = dom.window.document.createElement("template");
	template.content.appendChild(dom.window.document.createTextNode(hostile));
	wrapLongTokens(template.content);
	assert.equal(template.content.querySelector("img"), null);
	assert.equal(template.content.textContent, hostile);
	const many = `<p>${`<span>${link}</span> `.repeat(30_000)}</p>`;
	const started = performance.now();
	const big = wrap(many);
	assert(performance.now() - started < 10_000);
	assert.equal(big.content.textContent.length, 30_000 * (link.length + 1));
	assert(big.content.querySelectorAll("span wbr").length > 0);
	assert.equal(breaks(big.content.querySelectorAll("span")[25_000]), 0, "only so many pieces of text are read");
});
