import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import { runInNewContext } from "node:vm";
import { catalogScriptPath, catalogScriptSource, catalogVersion, readCatalogs } from "../scripts/locale-catalog-scripts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-i18n-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const outfile = join(outDir, "i18n.mjs");

// Catalogs other than English are static assets; tests serve them from public/ for both the browser
// `fetch` and the server's ASSETS binding. `testCatalogs` adds in-memory catalogs for an isolated locale.
globalThis.testCatalogs = {};
globalThis.readTestAsset = async (input) => {
	const path = new URL(String(input), "https://mailflare.local").pathname;
	const code = path.match(/^\/locales\/([\w-]+)\.json$/)?.[1];
	if (code && globalThis.testCatalogs[code]) return Response.json(globalThis.testCatalogs[code]);
	const file = join(root, "public", path);
	return existsSync(file) ? new Response(readFileSync(file)) : new Response("Not found", { status: 404 });
};
globalThis.fetch = globalThis.readTestAsset;

// `catalogVersion` builds as the Workers build does, where catalogues are scripts of their own.
async function bundleI18n(outfile, extraLocale = false, catalogVersion = null) {
	await build({
		define: catalogVersion ? { __MAILFLARE_CATALOG_VERSION__: JSON.stringify(catalogVersion) } : {},
		stdin: {
			contents: `
				import { createElement } from "react";
				import { renderToStaticMarkup } from "react-dom/server";
				import RootLayout from "./src/app/layout";
				import { LanguageProvider, useLanguage } from "./src/components/language-provider";
				import { LanguageSelector } from "./src/components/language-selector";
				import { loadMessages } from "./src/lib/i18n/utils";
				export * from "./src/lib/i18n/utils";
				export * from "./src/lib/i18n/locales";
				export { loadServerMessages } from "./src/lib/i18n/server";
				export { CATALOG_VERSION, catalogScriptUrl } from "./src/lib/i18n/catalog-registry";
				function Probe() { return createElement("span", null, useLanguage().t("navigation.inbox")); }
				export async function renderLanguage(locale) {
					const initialMessages = await loadMessages(locale);
					return renderToStaticMarkup(createElement(LanguageProvider, { initialLocale: locale, initialMessages }, createElement(Probe), createElement(LanguageSelector)));
				}
				export async function renderLayout(cookieValue, acceptLanguage) {
					globalThis.testLocaleCookie = cookieValue;
					globalThis.testAcceptLanguage = acceptLanguage;
					return renderToStaticMarkup(await RootLayout({ children: createElement(Probe) }));
				}
			`,
			resolveDir: root,
			loader: "tsx",
		},
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
		banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
		plugins: [{
			name: "layout-runtime-stubs",
			setup(builder) {
				if (extraLocale) builder.onLoad({ filter: /\/i18n\/locales\.ts$/ }, ({ path }) => ({
					contents: readFileSync(path, "utf8").replace("export const locales = {", `export const locales = {
						xx: { label: "Testlandic", dir: "rtl" },`),
					loader: "ts",
				}));
				builder.onResolve({ filter: /^(next\/headers|next\/font\/google|@\/components\/providers|@\/lib\/cloudflare)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
				builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({ contents: path === "next/headers"
					? 'export async function cookies() { return { get(name) { return name === "mailflare-locale" && globalThis.testLocaleCookie !== undefined ? { value: globalThis.testLocaleCookie } : undefined; } }; } export async function headers() { return { get(name) { return name === "accept-language" ? globalThis.testAcceptLanguage ?? null : null; } }; }'
					: path === "next/font/google"
						? 'export const Geist = () => ({ variable: "sans" }); export const Geist_Mono = () => ({ variable: "mono" });'
						: path === "@/lib/cloudflare"
							? "export function getEnv() { return { ASSETS: { fetch: globalThis.readTestAsset } }; }"
							: 'export function Providers({ children }) { return children; }' }));
				builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
			},
		}],
	});
}
await bundleI18n(outfile);

const i18n = await import(pathToFileURL(outfile).href);
const en = JSON.parse(readFileSync(join(root, "src/lib/i18n/en.json"), "utf8"));

const CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const categoryOf = (key) => CATEGORIES.find((category) => key.endsWith(`.${category}`));
const baseOf = (key) => categoryOf(key) ? key.slice(0, key.lastIndexOf(".")) : key;
const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
// A plural group is `base.other` plus any other CLDR categories; catalogs may carry the categories their language needs.
const pluralBases = new Set(Object.keys(en).filter((key) => key.endsWith(".other")).map(baseOf));
const isPluralKey = (key) => categoryOf(key) && pluralBases.has(baseOf(key));

test("primary languages are complete and optional catalogs retain valid translations with English fallback", async () => {
	for (const [code, { label }] of Object.entries(i18n.locales)) {
		const catalog = await i18n.loadMessages(code);
		assert.ok(label.trim().length > 0, code);
		const plain = (keys) => keys.filter((key) => !isPluralKey(key)).sort();
		if (code === "en" || code === "de") assert.deepEqual(plain(Object.keys(catalog)), plain(Object.keys(en)), `${code}: primary language keys differ from English`);
		else for (const key of plain(Object.keys(en))) if (!(key in catalog)) assert.equal(i18n.translate(catalog, key), en[key], `${code}: ${key} needs English fallback`);
		for (const base of pluralBases) if (code === "en" || code === "de" || Object.keys(catalog).some(key => isPluralKey(key) && baseOf(key) === base)) assert.ok(typeof catalog[`${base}.other`] === "string", `${code}: ${base}.other is required`);
		for (const key of Object.keys(catalog)) {
			if (isPluralKey(key)) assert.ok(`${baseOf(key)}.other` in catalog, `${code}: ${key} has no .other`);
			const value = catalog[key];
			assert.ok(typeof value === "string" && value.trim().length > 0, `${code}: ${key} is empty`);
			const reference = isPluralKey(key) ? en[`${baseOf(key)}.other`] : en[key];
			// A plural variant may drop {count} ("this message"), but never invent a placeholder.
			const allowed = placeholders(reference);
			const used = placeholders(value);
			if (isPluralKey(key)) assert.ok(used.every((name) => allowed.includes(name)), `${code}: ${key} uses an unknown {placeholder}`);
			else assert.deepEqual(used, allowed, `${code}: ${key} changes its {placeholders}`);
		}
	}
});

test("missing, invalid and unsupported locale values fall back to English", () => {
	for (const value of [undefined, null, "", "not-a-registered-locale", "pt-BR; Path=/", {}]) assert.equal(i18n.resolveLocale(value), "en");
	assert.equal(i18n.resolveLocale("en"), "en");
	assert.equal(i18n.resolveLocale("pt-BR"), "pt-BR");
});

test("translation uses the requested catalog and falls back per key", async () => {
	assert.equal(i18n.translate(await i18n.loadMessages("pt-BR"), "navigation.inbox"), "Entrada");
	assert.equal(i18n.translate({}, "navigation.inbox"), "Inbox");
});

test("preference cookie persists for a year, covers every path and is Secure on HTTPS", () => {
	assert.equal(i18n.serializeLocaleCookie("pt-BR", true), "mailflare-locale=pt-BR; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
	assert.equal(i18n.serializeLocaleCookie("en", false), "mailflare-locale=en; Path=/; Max-Age=31536000; SameSite=Lax");
	assert.equal(i18n.serializeLocaleCookie("bad; Domain=example.com", true), "mailflare-locale=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
});

test("provider server rendering uses initial locale and labels the language combobox", async () => {
	const pt = await i18n.renderLanguage("pt-BR");
	assert.match(pt, /Entrada/);
	assert.match(pt, /<label for="[^"]+"[^>]*>Idioma<\/label>/);
	const labelId = pt.match(/<label for="([^"]+)"/)?.[1];
	assert.ok(labelId);
	assert.match(pt, new RegExp(`<button[^>]*role="combobox"[^>]*id="${labelId}"[^>]*aria-label="Idioma"`));
	assert.match(pt, /<span lang="pt-BR">Português \(Brasil\)<\/span>/);
	assert.match(await i18n.renderLanguage("en"), /<span lang="en">English<\/span>/);
});

test("root layout passes the same cookie locale to HTML and provider on first render", async () => {
	const pt = await i18n.renderLayout("pt-BR");
	assert.match(pt, /<html lang="pt-BR"/);
	assert.match(pt, /Entrada/);
	for (const value of [undefined, "bad"]) {
		const english = await i18n.renderLayout(value);
		assert.match(english, /<html lang="en"/);
		assert.match(english, />Inbox<\/span>/);
	}
});

test("a locale registered once reaches resolution, translation, cookie, selector and SSR", async () => {
	assert.ok(existsSync(join(root, "src/lib/i18n/locales.ts")), "locales must have one shared registry");
	globalThis.testCatalogs.xx = { ...en, "navigation.inbox": "Entrada", "navigation.inbox.one": "{count} entrada", "navigation.inbox.other": "{count} entradas", "language.label": "Idioma" };
	const extraFile = join(outDir, "with-spanish.mjs");
	await bundleI18n(extraFile, true);
	const extended = await import(pathToFileURL(extraFile).href);
	assert.equal(extended.resolveLocale("xx"), "xx");
	assert.equal(extended.translate(await extended.loadMessages("xx"), "navigation.inbox"), "Entrada");
	assert.match(extended.serializeLocaleCookie("xx", true), /^mailflare-locale=xx;/);
	const selector = await extended.renderLanguage("xx");
	assert.match(selector, /<button[^>]*role="combobox"[^>]*dir="rtl"/);
	assert.match(selector, /<span lang="xx">Testlandic<\/span>/);
	assert.match(selector, />Entrada<\/span>/);
	const layout = await extended.renderLayout("xx");
	assert.match(layout, /<html lang="xx"/);
	assert.match(layout, />Entrada<\/span>/);
	assert.match(layout, /<html lang="xx" dir="rtl"/);
	const t = extended.createTranslator("xx", await extended.loadMessages("xx"));
	assert.equal(t("navigation.inbox", { count: 1 }), "1 entrada");
	assert.equal(t("navigation.inbox", { count: 3 }), "3 entradas");
	assert.equal(t("navigation.inbox"), "Entrada");
	for (const invalid of ["constructor", "toString", "__proto__"]) {
		assert.equal(extended.resolveLocale(invalid), "en");
	}
});

test("translations interpolate {vars}, keep unknown placeholders and default to ltr", async () => {
	assert.equal(i18n.translate({ "navigation.inbox": "Hi {name}, {other}" }, "navigation.inbox", { name: "Ana", count: 2 }), "Hi Ana, {other}");
	assert.equal(i18n.translate({}, "navigation.inbox", { name: "x" }), "Inbox");
	assert.equal(i18n.createTranslator("pt-BR", await i18n.loadMessages("pt-BR"))("navigation.inbox", { count: 2 }), "Entrada");
	assert.equal(i18n.getDirection("en"), "ltr");
});

test("a first visit is shown in the browser's language, and a chosen language always wins", () => {
	// What browsers send, most wanted first.
	assert.equal(i18n.negotiateLocale("de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"), "de");
	assert.equal(i18n.negotiateLocale("de-AT"), "de", "another region of a registered language");
	assert.equal(i18n.negotiateLocale("pt-PT,pt;q=0.9"), "pt-PT", "an exact region wins");
	assert.equal(i18n.negotiateLocale("pt"), "pt-BR", "a bare language takes the first region registered");
	assert.equal(i18n.negotiateLocale("zh-TW,zh;q=0.9"), "zh-CN");
	assert.equal(i18n.negotiateLocale("EN-us"), "en");
	// Quality decides, not position; q=0 means "never this one".
	assert.equal(i18n.negotiateLocale("en;q=0.5,fr;q=0.9"), "fr");
	assert.equal(i18n.negotiateLocale("de;q=0,fr"), "fr");
	assert.equal(i18n.negotiateLocale("de;q=0"), "en");
	// Languages Mailflare does not have fall through to the next, then to English.
	assert.equal(i18n.negotiateLocale("fi-FI,sv;q=0.8,de;q=0.5"), "de");
	assert.equal(i18n.negotiateLocale("fi,sv"), "en");
	for (const header of [null, undefined, "", "*", ";;;", ",,,", "de;q=abc", "<script>", "x".repeat(100_000), "de".repeat(50_000), "__proto__", "constructor;q=1"]) {
		const locale = i18n.negotiateLocale(header);
		assert.ok(Object.hasOwn(i18n.locales, locale), `always a registered language for ${String(header).slice(0, 20)}`);
	}
	assert.equal(i18n.negotiateLocale("de;q=abc"), "de", "an unreadable quality counts as fully wanted");
});

test("the root layout renders a first visit in the browser's language until one is chosen", async () => {
	const german = await i18n.renderLayout(undefined, "de-DE,de;q=0.9,en;q=0.8");
	assert.match(german, /<html lang="de"/);
	assert.match(german, />Posteingang<\/span>/);
	// A cookie that names no language is no choice; the browser's language still applies.
	assert.match(await i18n.renderLayout("bad", "de"), /<html lang="de"/);
	// A chosen language wins over the browser's, English included.
	assert.match(await i18n.renderLayout("en", "de-DE,de;q=0.9"), /<html lang="en"/);
	assert.match(await i18n.renderLayout("pt-BR", "de"), /<html lang="pt-BR"/);
	assert.match(await i18n.renderLayout(undefined, "fi"), /<html lang="en"/);
});

test("a catalogue script registers its language, completed with English, under one version for all", () => {
	const catalogs = readCatalogs(root);
	assert.deepEqual([...catalogs.keys()].filter((code) => code !== "en").sort(), Object.keys(i18n.locales).filter((code) => code !== "en").sort(), "every registered language has a catalogue");
	const run = (source, context = {}) => { runInNewContext(source, context); return context.__mailflareCatalogs; };

	const arabic = catalogs.get("ar");
	const untranslated = Object.keys(en).filter((key) => !(key in arabic));
	assert.ok(untranslated.length > 0, "Arabic is a catalogue with gaps");
	const registered = run(catalogScriptSource("ar", arabic, en));
	assert.deepEqual(Object.keys(registered), ["ar"]);
	assert.equal(registered.ar["navigation.sent"], arabic["navigation.sent"]);
	for (const key of untranslated) assert.equal(registered.ar[key], en[key], `${key} falls back to English inside the script`);
	assert.deepEqual(Object.keys(registered.ar).sort(), Object.keys({ ...en, ...arabic }).sort());

	// A second script adds to what the first registered; English is itself, untouched.
	const both = run(catalogScriptSource("en", en, en), { __mailflareCatalogs: registered });
	assert.deepEqual(Object.keys(both), ["ar", "en"]);
	assert.deepEqual({ ...both.en }, en);

	// Text that would end a string or a script element in other places is only ever data here.
	const hostile = { "navigation.inbox": "</script><script>globalThis.hit=1</script> \u2028 ' \" ` ${1} \\" };
	const context = {};
	assert.equal(run(catalogScriptSource("de", hostile, {}), context).de["navigation.inbox"], hostile["navigation.inbox"]);
	assert.equal(context.hit, undefined);

	assert.throws(() => catalogScriptSource("de", JSON.parse('{"__proto__":"x"}'), en), /__proto__/);
	assert.throws(() => catalogScriptSource("de", { "navigation.inbox": { nested: true } }, en), /not text/);
	for (const code of ["../en", "de.js", "", "a", "de\"]", "constructor()"]) assert.throws(() => catalogScriptSource(code, {}, en), /Not a language code/);

	const version = catalogVersion(catalogs);
	assert.match(version, /^[0-9a-f]{16}$/);
	assert.equal(catalogVersion(readCatalogs(root)), version, "the same text gives the same address");
	const changed = new Map(catalogs).set("de", { ...catalogs.get("de"), "navigation.inbox": "Eingang" });
	assert.notEqual(catalogVersion(changed), version, "changed text gives every language a new address");
	assert.equal(catalogScriptPath(version, "pt-BR"), `locales/${version}/pt-BR.js`);
});

test("a build with catalogue scripts names the script in the page and renders from the catalogue the server keeps", async () => {
	const file = join(outDir, "catalog-scripts.mjs");
	await bundleI18n(file, false, "0123456789abcdef");
	const built = await import(pathToFileURL(file).href);
	assert.equal(built.CATALOG_VERSION, "0123456789abcdef");
	assert.equal(i18n.CATALOG_VERSION, null, "a build without them keeps the catalogue in the page");
	assert.equal(i18n.catalogScriptUrl("de"), null);
	assert.equal(built.catalogScriptUrl("pt-BR"), "/_next/static/locales/0123456789abcdef/pt-BR.js");

	const reads = [];
	const readAsset = globalThis.readTestAsset;
	globalThis.readTestAsset = (input) => { reads.push(new URL(String(input), "https://mailflare.local").pathname); return readAsset(input); };
	try {
		delete globalThis.__mailflareCatalogs;
		const german = await built.renderLayout("de");
		assert.match(german, /<html lang="de"/);
		assert.match(german, /<script async="" src="\/_next\/static\/locales\/0123456789abcdef\/de\.js"><\/script>/);
		assert.match(german, />Posteingang<\/span>/, "rendered in German without the catalogue being passed along");
		assert.deepEqual(reads, ["/locales/de.json"]);

		// The isolate keeps the parsed catalogue: the next page does not read it again.
		assert.match(await built.renderLayout("de"), />Posteingang<\/span>/);
		assert.deepEqual(reads, ["/locales/de.json"]);

		// What the server keeps is what the script registers: the language completed with English.
		const arabic = JSON.parse(readFileSync(join(root, "public/locales/ar.json"), "utf8"));
		assert.deepEqual(await built.loadServerMessages("ar"), { ...en, ...arabic });

		const english = await built.renderLayout(undefined);
		assert.match(english, /<script async="" src="\/_next\/static\/locales\/0123456789abcdef\/en\.js"><\/script>/);
		assert.match(english, />Inbox<\/span>/);
		assert.equal(reads.filter((path) => path === "/locales/en.json").length, 0, "English is never read as an asset");

		// A catalogue that cannot be read renders in English and is tried again next time.
		globalThis.readTestAsset = async () => new Response("gone", { status: 404 });
		delete globalThis.__mailflareCatalogs;
		const failed = await built.renderLayout("de");
		assert.match(failed, /<html lang="de"/);
		assert.match(failed, />Inbox<\/span>/);
		globalThis.readTestAsset = readAsset;
		assert.match(await built.renderLayout("de"), />Posteingang<\/span>/);

		// Only so many languages are kept; the one loaded longest ago gives way.
		for (const code of ["fr", "es", "it", "nl", "pl", "tr", "ru"]) await built.loadServerMessages(code);
		assert.ok(Object.keys(globalThis.__mailflareCatalogs).length <= 6);
		assert.ok(globalThis.__mailflareCatalogs.ru, "the newest is kept");
	} finally {
		globalThis.readTestAsset = readAsset;
		delete globalThis.__mailflareCatalogs;
	}

	// The page of a build without catalogue scripts names none.
	assert.doesNotMatch(await i18n.renderLayout("de"), /static\/locales/);
});

test("a browser whose catalogue script cannot be loaded gets the language's file completed with English", async () => {
	const built = await import(pathToFileURL(join(outDir, "catalog-scripts.mjs")).href);
	const arabic = JSON.parse(readFileSync(join(root, "public/locales/ar.json"), "utf8"));
	const untranslated = Object.keys(en).find((key) => !(key in arabic));
	const fetched = [], real = { document: globalThis.document, fetch: globalThis.fetch, catalogs: globalThis.__mailflareCatalogs };
	// A page whose script elements always fail to load, as after a deployment removed the old scripts.
	globalThis.document = { createElement: () => ({}), head: { appendChild: (script) => queueMicrotask(() => script.onerror()) } };
	globalThis.fetch = async (path) => {
		fetched.push(String(path));
		if (path === "/locales/en.json") return Response.json(en);
		if (path === "/locales/ar.json") return Response.json(arabic);
		return new Response("gone", { status: 404 });
	};
	delete globalThis.__mailflareCatalogs;
	try {
		const messages = await built.loadMessages("ar");
		assert.deepEqual(messages, { ...en, ...arabic }, "exactly what its script and the server hold");
		if (untranslated) assert.equal(built.translate(messages, untranslated), en[untranslated], "an untranslated text is English, never a bare key");
		assert.deepEqual(fetched.sort(), ["/locales/ar.json", "/locales/en.json"]);
		assert.deepEqual(await built.loadMessages("en"), en, "English is read from its own file");
		// Without the English file the language still loads; without its own file the change fails and nothing is saved.
		globalThis.fetch = async (path) => (path === "/locales/ar.json" ? Response.json(arabic) : new Response("gone", { status: 404 }));
		assert.deepEqual(await built.loadMessages("ar"), arabic);
		await assert.rejects(built.loadMessages("en"), /unavailable/);
		await assert.rejects(built.loadMessages("de"), /unavailable/);
	} finally {
		globalThis.document = real.document; globalThis.fetch = real.fetch;
		if (real.catalogs) globalThis.__mailflareCatalogs = real.catalogs; else delete globalThis.__mailflareCatalogs;
	}
});
