// A mailto link clicked in a message or on any web page starts a message in Mailflare.
// A link is outside input: only addresses, a subject and text are taken from it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-mailto-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: { contents: `export * from "./src/components/compose/mailto-utils.ts"; export { GET as manifest } from "./src/app/manifest.webmanifest/route.ts";`, resolveDir: root, sourcefile: "mailto-entry.ts" },
	outfile: join(directory, "entry.mjs"), bundle: true, platform: "node", format: "esm", target: "node24", tsconfig: join(root, "tsconfig.json"), packages: "external", logLevel: "silent",
});
const app = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("a plain address link starts a message to that address", () => {
	assert.deepEqual(app.parseMailto("mailto:maya@example.com"), { to: ["maya@example.com"], cc: [], bcc: [], subject: "", body: "" });
	assert.deepEqual(app.parseMailto("MAILTO:Maya@Example.com").to, ["Maya@Example.com"]);
});

test("recipients, subject and text are read as RFC 6068 writes them", () => {
	const parsed = app.parseMailto("mailto:maya@example.com,dev@example.com?cc=lin@example.com&bcc=archive@example.com&subject=Termin%20am%20Dienstag%3F&body=Hallo%20Maya%2C%0D%0A%0D%0Apasst%2010%20Uhr%3F&to=extra@example.com");
	assert.deepEqual(parsed, { to: ["maya@example.com", "dev@example.com", "extra@example.com"], cc: ["lin@example.com"], bcc: ["archive@example.com"], subject: "Termin am Dienstag?", body: "Hallo Maya,\n\npasst 10 Uhr?" });
	assert.deepEqual(app.parseMailto("mailto:?subject=Nur%20Betreff"), { to: [], cc: [], bcc: [], subject: "Nur Betreff", body: "" });
	assert.equal(app.parseMailto("mailto:a+tag@example.com?subject=1+1").to[0], "a+tag@example.com", "a plus sign stays a plus sign");
	assert.equal(app.parseMailto("mailto:a@example.com?subject=1+1").subject, "1+1");
	assert.deepEqual(app.parseMailto("mailto:%22Chen%2C%20Maya%22%20%3Cmaya@example.com%3E").to, ['"Chen, Maya" <maya@example.com>'], "a name with a comma is one recipient");
	assert.equal(app.parseMailto("mailto:j%C3%BCrgen@example.com?subject=Gr%C3%BC%C3%9Fe").subject, "Grüße");
});

test("what is no mailto link, or names nothing, starts nothing", () => {
	for (const value of [null, undefined, "", "mailto:", "mailto:?", "mailto:?subject=", "https://example.com/?mailto:a@b.example", "javascript:alert(1)", "maya@example.com", " tel:+491234"])
		assert.equal(app.parseMailto(value), null, String(value));
});

test("a link cannot plant headers, attachments, markup or endless content", () => {
	const parsed = app.parseMailto("mailto:a@example.com?attach=/etc/passwd&attachment=C:%5Csecret.txt&x-header=1&from=boss@example.com&reply-to=evil@example.com&subject=Hi%0D%0ABcc:%20evil@example.com&body=%3Cscript%3Ealert(1)%3C/script%3E%00");
	assert.deepEqual(Object.keys(parsed).sort(), ["bcc", "body", "cc", "subject", "to"], "only recipients, a subject and text");
	assert.deepEqual(parsed.bcc, [], "a line break in the subject adds no recipient");
	assert.equal(parsed.subject, "Hi Bcc: evil@example.com", "the subject stays one line of text");
	assert.equal(parsed.body, "<script>alert(1)</script>", "the text is kept as text; the composer writes it as text, not as markup");
	assert.deepEqual(app.parseMailto("mailto:not-an-address,<script>,a@b.example,@,x@").to, ["a@b.example"], "only addresses become recipients");
	assert.equal(app.parseMailto(`mailto:${Array.from({ length: 500 }, (_, index) => `p${index}@example.com`).join(",")}`).to.length, 50);
	assert.equal(app.parseMailto(`mailto:a@example.com?subject=${"s".repeat(5000)}`).subject.length, 500);
	assert.equal(app.parseMailto(`mailto:a@example.com?body=${"b".repeat(60_000)}`).body.length, 50_000);
	assert.equal(app.parseMailto(`mailto:a@example.com?body=${"b".repeat(70_000)}`), null, "a link longer than any real one is refused whole");
	assert.deepEqual(app.parseMailto("mailto:a@example.com?subject=%E0%A4%A&body=%ZZ"), { to: ["a@example.com"], cc: [], bcc: [], subject: "%E0%A4%A", body: "%ZZ" }, "a broken escape is kept as written, not thrown on");
	assert.deepEqual(app.parseMailto("mailto:a@example.com,A@EXAMPLE.COM,a@example.com").to, ["a@example.com"], "the same address once");
});

test("the compose page reads a handed-over link or the parts named directly", () => {
	const params = (query) => new URLSearchParams(query);
	assert.deepEqual(app.prefillFromSearchParams(params(`mailto=${encodeURIComponent("mailto:maya@example.com?subject=Hallo%20Welt")}`)), { to: ["maya@example.com"], cc: [], bcc: [], subject: "Hallo Welt", body: "" });
	assert.deepEqual(app.prefillFromSearchParams(params("to=maya@example.com&cc=dev@example.com&subject=Hi&body=Text")), { to: ["maya@example.com"], cc: ["dev@example.com"], bcc: [], subject: "Hi", body: "Text" });
	assert.equal(app.prefillFromSearchParams(params("")), null, "an ordinary visit starts an empty message");
	assert.equal(app.prefillFromSearchParams(params("mailto=https://example.com")), null);
	assert.equal(app.prefillFromSearchParams(params("draft=1")), null);
});

test("the installed app offers itself for mail links at the address the compose page reads", async () => {
	const manifest = await app.manifest().json();
	assert.deepEqual(manifest.protocol_handlers, [{ protocol: "mailto", url: "/compose?mailto=%s" }]);
	// What the browser substitutes for %s is the encoded link; the page must read it back whole.
	const link = "mailto:maya@example.com?subject=A%26B&body=1%2B1%3D2";
	const visited = new URL(manifest.protocol_handlers[0].url.replace("%s", encodeURIComponent(link)), "https://mail.example");
	assert.equal(visited.pathname, "/compose");
	assert.deepEqual(app.prefillFromSearchParams(visited.searchParams), { to: ["maya@example.com"], cc: [], bcc: [], subject: "A&B", body: "1+1=2" });
	assert.equal(manifest.start_url, "/inbox", "the app still opens on the inbox");
});
