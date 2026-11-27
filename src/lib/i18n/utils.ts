import en from "./en.json";
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

/** Fetches the catalog for a locale; English is already bundled, others load on demand from `public/locales`. */
export async function loadMessages(locale: Locale, read: AssetReader = (path) => fetch(path)): Promise<Partial<Messages>> {
	if (locale === DEFAULT_LOCALE) return en;
	const response = await read(`/locales/${locale}.json`);
	if (!response.ok) throw new Error(`Catalog for ${locale} is unavailable (${response.status})`);
	return response.json();
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
