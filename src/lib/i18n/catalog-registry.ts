import type { Locale, Messages } from "./types";

// Set by the Vite build to the version of the catalogue scripts (`scripts/locale-catalog-scripts.mjs`).
// Absent in development, the Node build and tests, which keep the catalogue in the page instead.
declare const __MAILFLARE_CATALOG_VERSION__: string | undefined;

type Catalog = Partial<Messages>;
type Registry = Record<string, Catalog | undefined>;
type Global = typeof globalThis & { __mailflareCatalogs?: Registry };

/** The version of the built catalogue scripts, or null when this build has none. */
export const CATALOG_VERSION: string | null = typeof __MAILFLARE_CATALOG_VERSION__ === "string" && __MAILFLARE_CATALOG_VERSION__ ? __MAILFLARE_CATALOG_VERSION__ : null;

// Parsed catalogues a server isolate keeps; an installation is read in a handful of languages.
const MAX_SERVER_CATALOGS = 6;

function registry(): Registry {
	return ((globalThis as Global).__mailflareCatalogs ??= {});
}

/**
 * A catalogue already in memory: in the browser the one a catalogue script registered, on the server
 * the one the layout loaded for this render. Both sides read the same global, so server rendering and
 * hydration translate from the same text.
 */
export function registeredCatalog(locale: Locale): Catalog | undefined {
	const catalogs = (globalThis as Global).__mailflareCatalogs;
	return catalogs && Object.hasOwn(catalogs, locale) ? catalogs[locale] : undefined;
}

/** The catalogue registered first, for text asked for outside the language provider. */
export function anyRegisteredCatalog(): Catalog | undefined {
	const catalogs = (globalThis as Global).__mailflareCatalogs;
	if (!catalogs) return undefined;
	for (const code of Object.keys(catalogs)) if (catalogs[code]) return catalogs[code];
	return undefined;
}

export function registerCatalog(locale: Locale, messages: Catalog): Catalog {
	const catalogs = registry();
	if (!Object.hasOwn(catalogs, locale)) {
		const codes = Object.keys(catalogs);
		if (codes.length >= MAX_SERVER_CATALOGS) delete catalogs[codes[0]];
	}
	catalogs[locale] = messages;
	return messages;
}

/** Address of the catalogue script for a language, or null when this build keeps catalogues in the page. */
export function catalogScriptUrl(locale: Locale): string | null {
	return CATALOG_VERSION ? `/_next/static/locales/${CATALOG_VERSION}/${locale}.js` : null;
}

const pending = new Map<string, Promise<Catalog>>();

/**
 * Loads a language's catalogue script in the browser and resolves with what it registered. One
 * request per language however often it is asked for; the promise is stable so a component can
 * wait on it with `use`. A failed load is forgotten, so a later try can succeed.
 */
export function loadCatalogScript(locale: Locale): Promise<Catalog> {
	const ready = registeredCatalog(locale);
	if (ready) return Promise.resolve(ready);
	const known = pending.get(locale);
	if (known) return known;
	const url = catalogScriptUrl(locale);
	const loading = new Promise<Catalog>((resolve, reject) => {
		if (!url || typeof document === "undefined") { reject(new Error(`No catalogue script for ${locale}`)); return; }
		const script = document.createElement("script");
		script.src = url;
		script.async = true;
		script.onload = () => {
			const catalog = registeredCatalog(locale);
			if (catalog) resolve(catalog);
			else reject(new Error(`Catalogue script for ${locale} registered nothing`));
		};
		script.onerror = () => reject(new Error(`Catalogue script for ${locale} is unavailable`));
		document.head.appendChild(script);
	});
	pending.set(locale, loading);
	loading.catch(() => pending.delete(locale));
	return loading;
}
