"use client";

import { createContext, use, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CATALOG_VERSION, registeredCatalog } from "@/lib/i18n/catalog-registry";
import { DEFAULT_LOCALE, createTranslator, getDirection, loadMessages, resolveLocale, serializeLocaleCookie } from "@/lib/i18n/utils";
import type { Locale, Messages } from "@/lib/i18n/types";
import type { LanguageState } from "./language-provider-types";

const LanguageContext = createContext<LanguageState>({
	locale: DEFAULT_LOCALE,
	setLocale: () => undefined,
	t: createTranslator(DEFAULT_LOCALE),
});

type Active = { locale: Locale; messages?: Partial<Messages> };

// The catalogue hydration waits for when its script has not run yet. `loadMessages` falls back to the
// plain catalogue file if the script cannot be loaded; if that fails too the interface renders without
// translations rather than not at all. The promise is kept per language so `use` sees the same one on
// every render.
const startCatalogs = new Map<Locale, Promise<Partial<Messages> | undefined>>();
function startCatalog(locale: Locale) {
	let loading = startCatalogs.get(locale);
	if (!loading) startCatalogs.set(locale, loading = loadMessages(locale).catch(() => undefined));
	return loading;
}

/**
 * `initialMessages` is the catalog for `initialLocale` when the page carries it (development, the Node
 * build). A build with catalogue scripts passes none: the server rendered from the catalogue it keeps,
 * and the browser reads the one its script registered. Should hydration start before that script has
 * run, it waits for it; the server-rendered page stays visible meanwhile. Other catalogs load on
 * demand when the language changes.
 */
export function LanguageProvider({ initialLocale, initialMessages, children }: { initialLocale: Locale; initialMessages?: Partial<Messages>; children: ReactNode }) {
	const started = initialMessages
		?? (CATALOG_VERSION ? registeredCatalog(initialLocale) ?? (typeof document === "undefined" ? undefined : use(startCatalog(initialLocale))) : undefined);
	const [active, setActive] = useState<Active>({ locale: initialLocale, messages: started });
	const latestRequest = useRef(0);

	const setLocale = useCallback((next: Locale) => {
		const nextLocale = resolveLocale(next);
		const request = ++latestRequest.current;
		void loadMessages(nextLocale).then((messages) => {
			if (request !== latestRequest.current) return;
			// Preference cookies can be disabled; the selection still works for this session.
			try {
				document.cookie = serializeLocaleCookie(nextLocale, window.location.protocol === "https:");
			} catch {
				// Keep the in-memory preference when cookie storage is unavailable.
			}
			document.documentElement.lang = nextLocale;
			document.documentElement.dir = getDirection(nextLocale);
			setActive({ locale: nextLocale, messages });
		}).catch(() => undefined);
	}, []);

	const value = useMemo<LanguageState>(
		() => ({ locale: active.locale, setLocale, t: createTranslator(active.locale, active.messages) }),
		[active, setLocale],
	);

	return (
		<LanguageContext.Provider value={value}>
			{children}
		</LanguageContext.Provider>
	);
}

export function useLanguage() {
	return useContext(LanguageContext);
}
