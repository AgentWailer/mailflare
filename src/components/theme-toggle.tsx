"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { saveThemePreference } from "@/components/theme-utils";
import { Button } from "@/components/ui/button";

function subscribe(onChange: () => void) {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	return () => observer.disconnect();
}

const getSnapshot = () => document.documentElement.classList.contains("dark");
const getServerSnapshot = () => false;

export function ThemeToggle() {
	const { t } = useLanguage();
	const dark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	const label = `${t("settings.theme.label")}: ${t(dark ? "settings.theme.light" : "settings.theme.dark")}`;

	return (
		<Button
			type="button"
			variant="ghost"
			className="h-11 w-11 shrink-0 rounded-full px-0 text-neutral-600"
			aria-label={label}
			title={label}
			aria-pressed={dark}
			onClick={() => saveThemePreference(dark ? "light" : "dark")}
		>
			{dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
		</Button>
	);
}
