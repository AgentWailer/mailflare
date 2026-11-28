import { CATALOG_VERSION, loadCatalogScript } from "./catalog-registry";
import en from "./english";
import { DEFAULT_LOCALE, locales } from "./locales";
import type { Locale, Messages, PluralKey, TranslationKey } from "./types";

export { DEFAULT_LOCALE } from "./locales";
export const LOCALE_COOKIE = "mailflare-locale";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function resolveLocale(value: unknown): Locale {
	return typeof value === "string" && Object.hasOwn(locales, value) ? value as Locale : DEFAULT_LOCALE;
}

/**
 * The language of a first visit: the best match of the browser's `Accept-Language`
 * among the registered languages, English when none fits. An exact code wins
 * (`pt-PT`), then the same language in another region (`de-AT` reads German,
 * `pt` the first Portuguese registered). Bounded: a header is read as far as
 * any browser writes one.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
	if (!acceptLanguage) return DEFAULT_LOCALE;
	const registered = Object.keys(locales) as Locale[];
	const wanted = acceptLanguage.slice(0, 1000).split(",").slice(0, 30).map((part, index) => {
		const [tag, ...parameters] = part.trim().split(";");
		const quality = parameters.map((parameter) => parameter.trim().match(/^q=([01](?:\.\d{0,3})?)$/)?.[1]).find(Boolean);
		return { tag: tag.trim().toLowerCase(), quality: quality === undefined ? 1 : Number(quality), index };
	}).filter((entry) => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(entry.tag) && entry.quality > 0)
		.sort((a, b) => b.quality - a.quality || a.index - b.index);
	for (const { tag } of wanted) {
		const exact = registered.find((code) => code.toLowerCase() === tag);
		if (exact) return exact;
		const base = tag.split("-")[0];
		const sameLanguage = registered.find((code) => code.toLowerCase() === base) ?? registered.find((code) => code.toLowerCase().split("-")[0] === base);
		if (sameLanguage) return sameLanguage;
	}
	return DEFAULT_LOCALE;
}

export function getDirection(locale: Locale): "ltr" | "rtl" {
	return (locales[locale] as { dir?: "rtl" }).dir ?? "ltr";
}

/** Reads a static asset by path. The browser uses `fetch`; server code passes the `ASSETS` binding. */
export type AssetReader = (path: string) => Promise<Response>;

/**
 * Fetches the catalog for a locale. A build with catalogue scripts loads the language's script in the
 * browser (cached for good, already completed with English); if that fails, the language's plain
 * catalogue file is read, English included. Everywhere else other languages are read from
 * `public/locales` and English is the bundled catalogue.
 */
export async function loadMessages(locale: Locale, read?: AssetReader): Promise<Partial<Messages>> {
	// The browser of a build with catalogue scripts carries no English of its own (`english-client.ts`).
	const scripted = !read && !!CATALOG_VERSION && typeof document !== "undefined";
	if (scripted) {
		try {
			return await loadCatalogScript(locale);
		} catch {
			// A tab from before a deployment asks for scripts that are gone; the plain catalogue still exists.
		}
	}
	// There English is read as a file like every other language (the build writes `/locales/en.json`);
	// a failure is thrown, so a language change that did not happen is not saved as if it had.
	if (locale === DEFAULT_LOCALE && !scripted) return en;
	const get = read ?? ((path: string) => fetch(path));
	const file = async (code: Locale): Promise<Partial<Messages>> => {
		const response = await get(`/locales/${code}.json`);
		if (!response.ok) throw new Error(`Catalog for ${code} is unavailable (${response.status})`);
		return response.json();
	};
	if (!scripted || locale === DEFAULT_LOCALE) return file(locale);
	// A catalogue file holds only what is translated. Its script was completed with English, and so was
	// what the server rendered from: the fallback is completed the same way, or untranslated texts
	// would come out as bare keys and differ from the server's page.
	const [messages, english] = await Promise.all([file(locale), file(DEFAULT_LOCALE).catch(() => ({}))]);
	return { ...english, ...messages };
}

export type TranslationVars = Record<string, string | number | null | undefined>;
export type Translator = (key: TranslationKey | PluralKey, vars?: TranslationVars) => string;

function interpolate(template: string, vars?: TranslationVars): string {
	if (!vars) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(vars, name) ? String(vars[name] ?? "") : match));
}

export function translate(messages: Partial<Messages>, key: TranslationKey, vars?: TranslationVars): string {
	return interpolate(messages[key] ?? en[key] ?? key, vars);
}

// Server-safe translator. A numeric `count` var selects a plural variant: with
// `inbox.unread.one` / `inbox.unread.other` catalog entries, `t("inbox.unread", { count })`
// uses the locale's CLDR category and falls back to the bare key when no variant exists.
export function createTranslator(locale: Locale, messages: Partial<Messages> = en): Translator {
	const rules = new Intl.PluralRules(locale);
	const known = (key: string) => key in messages || key in en;
	return (key, vars) => {
		const count = vars?.count;
		if (typeof count === "number") {
			for (const category of [rules.select(count), "other"]) {
				const variant = `${key}.${category}`;
				if (known(variant)) return translate(messages, variant as TranslationKey, vars);
			}
		}
		return translate(messages, key as TranslationKey, vars);
	};
}

export function serializeLocaleCookie(locale: Locale, secure: boolean): string {
	return `${LOCALE_COOKIE}=${resolveLocale(locale)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Default for pure helpers that take an optional translator, so callers without one (and tests) get English. */
export const defaultTranslator: Translator = createTranslator(DEFAULT_LOCALE, en);
