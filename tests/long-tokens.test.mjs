// Very long unbroken strings in a message get places to break; ordinary words and amounts stay whole.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const bundle = await build({ entryPoints: ["src/components/messages/long-tokens.ts"], bundle: true, write: false, platform: "browser", format: "esm", tsconfig: "tsconfig.json" });
const { wrapLongTokens, splitLongToken, LONG_TOKEN_LENGTH, LONG_TOKEN_PIECE } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

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
	const just = "x".repeat(LONG_TOKEN_LENGTH), under = "x".repeat(LONG_TOKEN_LENGTH - 1);
	assert.equal(breaks(wrap(`<p>${under}</p>`).content), 0);
	assert(breaks(wrap(`<p>${just}</p>`).content) > 0);
	assert.equal(breaks(wrap("<p>Versicherungsbedingungen und Rechtsschutzversicherung 1.264,98&nbsp;€</p>").content), 0, "ordinary long words and amounts stay whole");
	assert.equal(breaks(wrap(`<p>${under} ${under}​${under}­${under}</p>`).content), 0, "a no-break space, a zero-width space and a soft hyphen end a string");
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
