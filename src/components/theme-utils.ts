export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "mailflare-theme";
export const THEME_CHANGED_EVENT = "mailflare:theme-changed";

// Safari uses these document colors for its browser chrome and standalone app.
// iOS may apply the Apple status-bar style only when the app starts again.
function syncThemeChrome(dark: boolean): void {
	document.documentElement.style.colorScheme = dark ? "dark" : "light";
	for (const [name, content] of [
		["theme-color", dark ? "#202124" : "#f6f8fc"],
		["apple-mobile-web-app-status-bar-style", dark ? "black-translucent" : "default"],
	]) {
		const existing = [...document.querySelectorAll<HTMLMetaElement>(`meta[name="${name}"]`)];
		if (!existing.length) {
			const meta = document.createElement("meta");
			meta.name = name;
			document.head.appendChild(meta);
			existing.push(meta);
		}
		for (const meta of existing) meta.content = content;
	}
}

// Runs in <head> before paint, so the first frame already has the right theme (same approach as the
// sidebar width). Keep it in sync with resolveTheme/applyTheme below.
export const themeBootstrapScript = `(() => {
	try {
		const saved = localStorage.getItem("mailflare-theme");
		const preference = saved === "light" || saved === "dark" ? saved : "system";
		const dark = preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
		document.documentElement.classList.toggle("dark", dark);
		document.documentElement.classList.toggle("light", !dark);
		(${syncThemeChrome.toString()})(dark);
	} catch {}
})();`;

export function isThemePreference(value: unknown): value is ThemePreference {
	return value === "light" || value === "dark" || value === "system";
}

export function readThemePreference(): ThemePreference {
	if (typeof window === "undefined") return "system";
	try {
		const saved = localStorage.getItem(THEME_STORAGE_KEY);
		return isThemePreference(saved) ? saved : "system";
	} catch {
		return "system";
	}
}

export function resolveTheme(preference: ThemePreference): "light" | "dark" {
	if (preference !== "system") return preference;
	if (typeof window === "undefined") return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(preference: ThemePreference): void {
	if (typeof document === "undefined") return;
	const dark = resolveTheme(preference) === "dark";
	document.documentElement.classList.toggle("dark", dark);
	document.documentElement.classList.toggle("light", !dark);
	syncThemeChrome(dark);
}

export function saveThemePreference(preference: ThemePreference): void {
	try {
		if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
		else localStorage.setItem(THEME_STORAGE_KEY, preference);
	} catch {
		// Storage can be unavailable in private windows; the theme still applies for this page.
	}
	applyTheme(preference);
	if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: preference }));
}
