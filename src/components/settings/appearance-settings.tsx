"use client";

import { useEffect, useId, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import type { TranslationKey } from "@/lib/i18n/types";
import { Select } from "@/components/ui/select";
import {
	isThemePreference,
	readThemePreference,
	saveThemePreference,
	THEME_CHANGED_EVENT,
	type ThemePreference,
} from "@/components/theme-utils";

const OPTIONS: { value: ThemePreference; labelKey: TranslationKey }[] = [
	{ value: "system", labelKey: "settings.theme.system" },
	{ value: "light", labelKey: "settings.theme.light" },
	{ value: "dark", labelKey: "settings.theme.dark" },
];

export function AppearanceSettings({ compact = false, visual = false }: { compact?: boolean; visual?: boolean } = {}) {
	const { t } = useLanguage();
	const name = useId();
	const [preference, setPreference] = useState<ThemePreference>("system");

	useEffect(() => {
		setPreference(readThemePreference());
		const sync = () => setPreference(readThemePreference());
		window.addEventListener(THEME_CHANGED_EVENT, sync);
		return () => window.removeEventListener(THEME_CHANGED_EVENT, sync);
	}, []);

	if (visual) return <fieldset className="mail-theme-options"><legend className="mb-3 text-sm font-semibold text-neutral-900">{t("settings.theme.label")}</legend><div className="grid grid-cols-3 gap-2">
		{[OPTIONS[1], OPTIONS[2], OPTIONS[0]].map(option => <label key={option.value} className="grid cursor-pointer grid-cols-[14px_minmax(0,1fr)] items-center gap-x-1 text-xs text-neutral-700"><input type="radio" name={name} value={option.value} checked={preference === option.value} onChange={() => { setPreference(option.value); saveThemePreference(option.value); }} className="peer h-3.5 w-3.5 accent-blue-600" /><span aria-hidden="true" data-theme-preview={option.value} className="mail-theme-preview order-first col-span-2 mb-2 flex h-14 overflow-hidden rounded-lg border-2 border-neutral-200 peer-checked:border-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400"><i /><b><em /><em /><em /></b></span><span>{t(option.labelKey)}</span></label>)}
	</div></fieldset>;
	return (
		<label className={compact ? "flex min-w-0 flex-col gap-1" : "flex items-start gap-3 rounded-xl bg-neutral-50 p-4"}>
			<span className="flex-1">
				<span className={compact ? "block text-xs text-neutral-600" : "block text-sm font-medium text-neutral-900"}>{t("settings.theme.label")}</span>
				{!compact && <span className="mt-1 block text-sm text-neutral-500">
					{t("settings.theme.description")}
				</span>}
			</span>
			<Select
				value={preference}
				aria-label={t("settings.theme.label")}
				className={compact ? "min-h-11 w-full rounded-lg py-2 text-sm text-neutral-900" : "py-1.5 text-sm text-neutral-900"}
				onChange={(event) => {
					const next = event.target.value;
					if (!isThemePreference(next)) return;
					setPreference(next);
					saveThemePreference(next);
				}}
			>
				{OPTIONS.map((option) => (
					<option key={option.value} value={option.value}>
						{t(option.labelKey)}
					</option>
				))}
			</Select>
		</label>
	);
}
