import { anyRegisteredCatalog, registeredCatalog } from "./catalog-registry";
import type { Messages } from "./types";

/**
 * Stands in for `english.ts` in the Workers browser build. English is not bundled there: the page
 * loads one catalogue script for its language, already completed with English where a translation is
 * missing. This reads the English script when it is loaded (an English interface, or after switching
 * to it) and otherwise the catalogue that is, so text asked for without a translator comes out in the
 * reader's language instead of as a bare key.
 */
function lookup(): Partial<Messages> | undefined {
	return registeredCatalog("en") ?? anyRegisteredCatalog();
}

const english = new Proxy({} as Messages, {
	get: (_target, key) => (typeof key === "string" ? lookup()?.[key as keyof Messages] : undefined),
	has: (_target, key) => typeof key === "string" && key in (lookup() ?? {}),
	ownKeys: () => Object.keys(lookup() ?? {}),
	getOwnPropertyDescriptor: (_target, key) => {
		const value = typeof key === "string" ? lookup()?.[key as keyof Messages] : undefined;
		return value === undefined ? undefined : { value, enumerable: true, configurable: true };
	},
});

export default english;
