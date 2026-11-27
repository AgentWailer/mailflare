import { cookies, headers } from "next/headers";
import { getEnv } from "@/lib/cloudflare";
import { LOCALE_COOKIE, createTranslator, loadMessages, negotiateLocale, resolveLocale } from "./utils";
import { locales } from "./locales";
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

/** Server-side catalog load through the static assets binding; English when the catalog cannot be read. */
export async function loadServerMessages(locale: Locale): Promise<Partial<Messages> | undefined> {
	try {
		const assets = getEnv().ASSETS;
		return await loadMessages(locale, (path) => assets.fetch(new URL(path, "https://mailflare.local")));
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
