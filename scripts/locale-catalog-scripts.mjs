// Builds the interface catalogues as scripts the browser caches for good, so a page no longer
// carries its language inline and the startup bundle no longer carries English for everyone.
// Used by the Vite build (vite.config.ts) and by tests; pure apart from reading the catalogues.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_CATALOG = "en";
export const CATALOG_GLOBAL = "__mailflareCatalogs";

/** Every catalogue by language code: English from the source tree, the others from `public/locales`. */
export function readCatalogs(root) {
	const catalogs = new Map([[DEFAULT_CATALOG, JSON.parse(readFileSync(join(root, "src/lib/i18n/en.json"), "utf8"))]]);
	const directory = join(root, "public/locales");
	for (const file of readdirSync(directory).sort()) {
		if (!file.endsWith(".json")) continue;
		catalogs.set(file.slice(0, -".json".length), JSON.parse(readFileSync(join(directory, file), "utf8")));
	}
	return catalogs;
}

/** One version for all catalogues: any changed text gives every language a new, uncached address. */
export function catalogVersion(catalogs) {
	const hash = createHash("sha256");
	for (const code of [...catalogs.keys()].sort()) hash.update(code).update("\0").update(JSON.stringify(catalogs.get(code))).update("\0");
	return hash.digest("hex").slice(0, 16);
}

/** Path below the static asset root, which is served immutable. Mirrors `catalogScriptUrl` in the app. */
export function catalogScriptPath(version, code) {
	return `locales/${version}/${code}.js`;
}

/**
 * The script for one language. English fills the keys a catalogue has not translated, so the browser
 * needs no second catalogue to fall back on. JSON is valid JavaScript; only a `__proto__` key would
 * mean something else there, and no catalogue may have one.
 */
export function catalogScriptSource(code, catalog, english) {
	if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(code)) throw new Error(`Not a language code: ${code}`);
	const merged = code === DEFAULT_CATALOG ? english : { ...english, ...catalog };
	for (const [key, value] of Object.entries(merged)) {
		if (key === "__proto__") throw new Error(`${code}: a catalogue key may not be __proto__`);
		if (typeof value !== "string") throw new Error(`${code}: ${key} is not text`);
	}
	return `(globalThis.${CATALOG_GLOBAL}??={})[${JSON.stringify(code)}]=${JSON.stringify(merged)};\n`;
}
