import type { RefineInput } from "@/lib/agent/refine-input";

export type RefinePreferences = Pick<RefineInput, "mode" | "language">;
const KEY = "mailflare-refine-preferences";
const MODES = ["polish", "correct", "professional", "friendly", "shorter", "longer"];
const LANGUAGES = ["keep", "de", "en"];

export function readRefinePreferences(): RefinePreferences {
	try {
		const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
		if (value && MODES.includes(value.mode) && LANGUAGES.includes(value.language)) return { mode: value.mode, language: value.language };
	} catch { /* Private browsing or invalid preferences: use the defaults. */ }
	return { mode: "polish", language: "keep" };
}

export function saveRefinePreferences(value: RefinePreferences) {
	try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* Preferences are optional. */ }
}
