import { cookies, headers } from "next/headers";
import { getEnv } from "@/lib/cloudflare";
import { LOCALE_COOKIE, createTranslator, loadMessages, negotiateLocale, resolveLocale } from "./utils";
import { CATALOG_VERSION, registerCatalog, registeredCatalog } from "./catalog-registry";
import en from "./english";
import { DEFAULT_LOCALE, locales } from "./locales";
import type { Locale, Messages } from "./types";

/**
 * The locale server code must render in: the one chosen in the preference cookie,
 * and before anything was chosen the browser's own language, so a first visit is
 * not in English for a reader whose browser asks for German.
 */
export async function getRequestLocale() {
	const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
	if (typeof chosen === "string" && Object.hasOwn(locales, chosen)) return resolveLocale(chosen);
	return negotiateLocale((await headers()).get("accept-language"));
}

/**
 * Server-side catalog load through the static assets binding; English when the catalog cannot be read.
 * A build with catalogue scripts keeps each language parsed for the life of the isolate, completed
 * with English exactly as its script is, so server rendering and the browser translate from the same
 * text and a request no longer reads and parses the catalogue again.
 */
export async function loadServerMessages(locale: Locale): Promise<Partial<Messages> | undefined> {
	if (CATALOG_VERSION) {
		const kept = registeredCatalog(locale);
		if (kept) return kept;
		if (locale === DEFAULT_LOCALE) return registerCatalog(locale, en);
	}
	try {
		const assets = getEnv().ASSETS;
		const messages = await loadMessages(locale, (path) => assets.fetch(new URL(path, "https://mailflare.local")));
		return CATALOG_VERSION ? registerCatalog(locale, { ...en, ...messages }) : messages;
	} catch (error) {
		console.warn(`Falling back to English: ${error instanceof Error ? error.message : error}`);
		return undefined;
	}
}

// For server components and route handlers; client components use `useLanguage()`.
export async function getServerTranslator() {
	const locale = await getRequestLocale();
	return createTranslator(locale, await loadServerMessages(locale));
}
