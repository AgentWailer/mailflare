// Only very long unbroken strings in a message may break anywhere; ordinary words and amounts stay whole.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const bundle = await build({ entryPoints: ["src/components/messages/long-tokens.ts"], bundle: true, write: false, platform: "browser", format: "esm", tsconfig: "tsconfig.json" });
const { wrapLongTokens, LONG_TOKEN_TAG, LONG_TOKEN_LENGTH, LONG_TOKEN_STYLE } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function wrap(html) {
	const template = dom.window.document.createElement("template");
	template.innerHTML = html;
	wrapLongTokens(template.content);
	return template;
}
const tokens = (template) => [...template.content.querySelectorAll(LONG_TOKEN_TAG)].map((node) => node.textContent);
const link = "https://example.com/confirm/8f2c1a9e7b6d4c3f2a1b0e9d8c7f6a5b4c3d2e1f";

test("a receipt's amounts, dates and words are left exactly as they are", () => {
	const html = '<table><tr><td>Obsidian Sync yearly subscription (Plus 10 GB plan)</td><td align="right">$114.24</td></tr><tr><td>November 27, 2026 at 5:52:31 PM EST</td><td>American Express - 1002</td></tr></table>';
	const template = wrap(html);
	assert.deepEqual(tokens(template), []);
	assert.equal(template.innerHTML, wrap(html).innerHTML);
	assert.equal(template.content.querySelectorAll("td").length, 4);
});

test("a long link is wrapped where it stands, with the text around it and its markup untouched", () => {
	const template = wrap(`<p>Bitte hier bestätigen: ${link} Danke!</p><p><a href="${link}">${link}</a></p>`);
	assert.deepEqual(tokens(template), [link, link]);
	const [first, second] = template.content.querySelectorAll("p");
	assert.equal(first.textContent, `Bitte hier bestätigen: ${link} Danke!`, "no character is lost or added");
	assert.equal(first.firstChild.data, "Bitte hier bestätigen: ");
	assert.equal(first.lastChild.data, " Danke!");
	assert.equal(second.querySelector("a").getAttribute("href"), link, "the link still leads where it led");
	assert.equal(second.querySelector(`a > ${LONG_TOKEN_TAG}`).textContent, link);
	assert.match(LONG_TOKEN_STYLE, new RegExp(`^${LONG_TOKEN_TAG}\\{overflow-wrap:anywhere\\}$`));
});

test("the limit is a length no ordinary word reaches, counted between spaces of any kind", () => {
	const just = "x".repeat(LONG_TOKEN_LENGTH), under = "x".repeat(LONG_TOKEN_LENGTH - 1);
	assert.deepEqual(tokens(wrap(`<p>${under} ${just}</p>`)), [just]);
	assert.deepEqual(tokens(wrap("<p>Donaudampfschifffahrtsgesellschaft und Versicherungsbedingungen</p>")), ["Donaudampfschifffahrtsgesellschaft"], "a very long compound may break, an ordinary one stays whole");
	assert.deepEqual(tokens(wrap(`<p>${under} ${under}​${under}</p>`)), [], "a no-break space and a zero-width space end a string");
	assert.deepEqual(tokens(wrap(`<p>${just}</p><p>${just} ${just}</p>`)), [just, just, just]);
});

test("text that is written to be read as it stands is not touched, and a second pass changes nothing", () => {
	const template = wrap(`<pre>${link}</pre><code>${link}</code><style>.a{background:url(${link})}</style><p>${link}</p>`);
	assert.deepEqual(tokens(template), [link], "only the paragraph");
	assert.equal(template.content.querySelector("pre").innerHTML, link);
	const once = template.innerHTML;
	wrapLongTokens(template.content);
	assert.equal(template.innerHTML, once);
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
	assert(performance.now() - started < 8000);
	assert(tokens(big).length <= 20_000, "only so many pieces of text are read");
	assert.equal(big.content.textContent.length, dom.window.document.createRange().createContextualFragment(many).textContent.length);
});
