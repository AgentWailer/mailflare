"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { cn } from "@/lib/utils";
import { isActiveSettingsPath, settingsNavSections } from "./settings-nav-utils";
import { MobileSettingsNav } from "./mobile-settings-nav";

export function SettingsNav() {
	const { t } = useLanguage();
	const pathname = usePathname();
	return <aside className="md:w-56 md:shrink-0 md:px-4 md:py-6" aria-label={t("settings.nav.menu")}>
		<MobileSettingsNav key={pathname} pathname={pathname} />
		<div data-settings-desktop-nav className="sticky top-6 hidden space-y-6 md:block">
			{settingsNavSections.map(section => <nav key={section.labelKey} aria-label={t(section.labelKey)} className="space-y-1">
				<h2 className="mb-2 px-3 text-xs font-semibold text-neutral-500">{t(section.labelKey)}</h2>
				{section.items.map(item => {
					const active = isActiveSettingsPath(pathname, item.href);
					return <Link prefetch={false} key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={cn("block min-h-11 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors", active ? "bg-blue-100 text-blue-900" : "text-neutral-600 hover:bg-white hover:text-neutral-900")}>{t(item.labelKey)}</Link>;
				})}
			</nav>)}
		</div>
	</aside>;
}
