"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { cn } from "@/lib/utils";
import { SectionNavSheet } from "../section-nav-sheet";
import { isActiveSettingsPath, settingsNavSections } from "./settings-nav-utils";

export function SettingsNav() {
	const { t } = useLanguage();
	const pathname = usePathname();
	const currentItem = settingsNavSections.flatMap((section) => section.items).find((item) => isActiveSettingsPath(pathname, item.href));
	const currentLabel = t(currentItem?.labelKey ?? "settings.nav.settings");

	return (
		<SectionNavSheet title={t("settings.nav.menu")} label={currentLabel} className="w-full px-4 py-4 md:w-56 md:shrink-0 md:py-6">
			<div className="sticky top-6 space-y-2">
				{settingsNavSections.map((section) => (
					<details key={`${section.labelKey}:${pathname}`} open={section.items.some(item => isActiveSettingsPath(pathname, item.href)) || undefined} className="group rounded-xl border border-neutral-200/70 bg-white/60">
						<summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 text-sm font-medium text-neutral-700 [&::-webkit-details-marker]:hidden">
							{t(section.labelKey)}
						<ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-neutral-400 group-open:rotate-180" />
						</summary>
						<nav aria-label={t(section.labelKey)} className="space-y-1 px-2 pb-2">
							{section.items.map((item) => {
								const active = isActiveSettingsPath(pathname, item.href);
								return (
									<Link
										key={item.href}
										href={item.href}
										aria-current={active ? "page" : undefined}
										className={cn(
											"block min-h-11 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
											active
												? "bg-blue-100 text-blue-900"
												: "text-neutral-600 hover:bg-white/70 hover:text-neutral-900",
										)}
									>
										{t(item.labelKey)}
									</Link>
								);
							})}
						</nav>
					</details>
				))}
			</div>
		</SectionNavSheet>
	);
}
