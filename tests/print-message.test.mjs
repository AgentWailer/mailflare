// Printing one message: the printer gets the message, sanitised, and never the application around it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='app'>Inbox, sidebar, toolbars</div></body></html>", { url: "https://mail.example/inbox/m1" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
let printed = 0, failPrint = false;
dom.window.print = () => { printed++; if (failPrint) throw new Error("printing is not available"); };
dom.window.matchMedia = () => ({ matches: false });
const bundle = await build({ entryPoints: ["src/components/messages/print-message.ts"], bundle: true, write: false, platform: "browser", format: "esm", tsconfig: "tsconfig.json" });
const { printMessage } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const headers = [{ label: "Von", value: '"Stadtwerke" <rechnung@stadtwerke.example>' }, { label: "An", value: "steffen@lumen.example" }, { label: "Cc", value: "" }, { label: "Datum", value: "Donnerstag, 26. November 2026 um 10:00" }];
const root = () => document.getElementById("mailflare-print-root");

test("the printout holds the subject, the header lines that have a value, and the message", () => {
	printMessage({ subject: "Ihre Rechnung <November>", headers, html: "<p>Betrag: <b>84,20 €</b></p>" });
	assert.equal(printed, 1);
	assert.equal(document.documentElement.classList.contains("mailflare-printing"), true);
	const shadow = root().shadowRoot;
	assert.equal(shadow.querySelector("h1").textContent, "Ihre Rechnung <November>", "the subject is text, never markup");
	assert.deepEqual([...shadow.querySelectorAll("dt")].map((node) => node.textContent), ["Von", "An", "Datum"], "an empty Cc line is left out");
	assert.equal(shadow.querySelector("dd").textContent, '"Stadtwerke" <rechnung@stadtwerke.example>');
	assert.equal(shadow.querySelector("main b").textContent, "84,20 €");
	assert.equal(document.getElementById("app").textContent, "Inbox, sidebar, toolbars", "the application itself is untouched");
});

test("after printing the page is as before, and printing again replaces the earlier printout", () => {
	printMessage({ subject: "Zweite", headers, text: "Nur Text" });
	assert.equal(document.querySelectorAll("#mailflare-print-root").length, 1);
	assert.equal(root().shadowRoot.querySelector("h1").textContent, "Zweite");
	dom.window.dispatchEvent(new dom.window.Event("afterprint"));
	assert.equal(root(), null);
	assert.equal(document.documentElement.classList.contains("mailflare-printing"), false);
});

test("a printout runs nothing from the message and fetches nothing from the web", () => {
	printMessage({ subject: "S", headers: [{ label: "Von", value: "<img src=x onerror=alert(1)>" }], html: '<p onclick="steal()">Text</p><script>steal()</script><img src="https://tracker.example/pixel.gif"><img src="/api/messages/m1/attachments/a1?preview=1"><a href="javascript:steal()">Link</a><iframe src="https://evil.example"></iframe><style>@import "https://evil.example/x.css";</style>' });
	const shadow = root().shadowRoot, html = shadow.querySelector("main").innerHTML;
	assert.doesNotMatch(html, /<script|onclick|javascript:|<iframe|tracker\.example|evil\.example|@import/);
	assert.match(html, /\/api\/messages\/m1\/attachments\/a1\?preview=1/, "a picture attached to the message is printed");
	assert.equal(shadow.querySelector("dd").textContent, "<img src=x onerror=alert(1)>", "header values are text");
	assert.equal(shadow.querySelector("dd img"), null);
	dom.window.dispatchEvent(new dom.window.Event("afterprint"));
});

test("plain text is printed as written, and a browser that cannot print leaves the page usable", () => {
	printMessage({ subject: "Text", headers: [], text: "Zeile 1\n  <b>kein Markup</b>" });
	assert.equal(root().shadowRoot.querySelector("pre").textContent, "Zeile 1\n  <b>kein Markup</b>");
	assert.equal(root().shadowRoot.querySelector("pre b"), null);
	dom.window.dispatchEvent(new dom.window.Event("afterprint"));
	failPrint = true;
	printMessage({ subject: "Text", headers: [], text: "x" });
	assert.equal(root(), null, "nothing is left hiding the application");
	assert.equal(document.documentElement.classList.contains("mailflare-printing"), false);
});
