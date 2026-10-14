"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { cn } from "@/lib/utils";
import { isActiveSettingsPath, settingsNavSections } from "./settings-nav-utils";

export function SettingsNav() {
	const { t } = useLanguage();
	const pathname = usePathname();
	const router = useRouter();
	const currentItem = settingsNavSections.flatMap(section => section.items).find(item => isActiveSettingsPath(pathname, item.href));
	return <aside className="w-full px-4 pt-4 md:w-56 md:shrink-0 md:py-6" aria-label={t("settings.nav.menu")}>
		<label className="block space-y-2 md:hidden">
			<span className="text-xs font-medium text-neutral-500">{t("settings.nav.settings")}</span>
			<select aria-label={t("settings.nav.menu")} value={currentItem?.href ?? "/settings/account"} onChange={event => router.push(event.target.value)} className="min-h-11 w-full rounded-xl border border-neutral-200 bg-white px-3 text-base font-medium text-neutral-900">
				{settingsNavSections.map(section => <optgroup key={section.labelKey} label={t(section.labelKey)}>{section.items.map(item => <option key={item.href} value={item.href}>{t(item.labelKey)}</option>)}</optgroup>)}
			</select>
		</label>
		<div className="sticky top-6 hidden space-y-6 md:block">
			{settingsNavSections.map(section => <nav key={section.labelKey} aria-label={t(section.labelKey)} className="space-y-1">
				<h2 className="mb-2 px-3 text-xs font-semibold text-neutral-500">{t(section.labelKey)}</h2>
				{section.items.map(item => {
					const active = isActiveSettingsPath(pathname, item.href);
					return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={cn("block min-h-11 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors", active ? "bg-blue-100 text-blue-900" : "text-neutral-600 hover:bg-white hover:text-neutral-900")}>{t(item.labelKey)}</Link>;
				})}
			</nav>)}
		</div>
	</aside>;
}
