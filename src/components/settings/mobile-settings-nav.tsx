"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, Download, Inbox, KeyRound, ListFilter, MoreHorizontal, ShieldCheck, Smartphone, Upload, UserRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { cn } from "@/lib/utils";
import { isActiveSettingsPath, settingsNavSections } from "./settings-nav-utils";

const icons: Record<string, LucideIcon> = {
	"/settings/account": UserRound,
	"/settings/security": ShieldCheck,
	"/settings/inbox": Inbox,
	"/settings/rules": ListFilter,
	"/settings/api-keys": KeyRound,
	"/settings/app-passwords": Smartphone,
	"/settings/import": Download,
	"/settings/export": Upload,
};
const primaryItems = [settingsNavSections[0].items[0], settingsNavSections[1].items[0]];
const targetClass = "flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 motion-reduce:transition-none";

/** One-tap frequent destinations; secondary destinations stay in a modal within thumb reach. */
export function MobileSettingsNav({ pathname }: { pathname: string }) {
	const { t } = useLanguage();
	const [open, setOpen] = useState(false);
	const secondaryActive = !primaryItems.some(item => isActiveSettingsPath(pathname, item.href));

	useEffect(() => {
		const desktop = window.matchMedia("(min-width: 768px)");
		const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
		desktop.addEventListener("change", closeOnDesktop);
		return () => desktop.removeEventListener("change", closeOnDesktop);
	}, []);

	return <Dialog.Root open={open} onOpenChange={setOpen}>
		<nav data-settings-mobile-nav aria-label={t("settings.nav.menu")} className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-white shadow-[0_-2px_12px_rgb(0_0_0/0.04)] md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)", paddingLeft: "max(8px, env(safe-area-inset-left, 0px))", paddingRight: "max(8px, env(safe-area-inset-right, 0px))" }}>
			<div className="mx-auto grid max-w-lg grid-cols-4 gap-1 [&>a>span:last-child]:max-w-full [&>a>span:last-child]:break-words">
				<Link href="/inbox" className={targetClass}>
					<ArrowLeft aria-hidden="true" className="h-5 w-5" /><span>{t("settings.nav.mailbox")}</span>
				</Link>
				{primaryItems.map(item => {
					const active = isActiveSettingsPath(pathname, item.href), Icon = icons[item.href];
					return <Link key={item.href} href={item.href} aria-label={item.href === "/settings/inbox" ? `${t("settings.nav.settings")}: ${t(item.labelKey)}` : undefined} aria-current={active ? "page" : undefined} className={cn(targetClass, active && "text-blue-800")}>
						<span className={cn("flex h-7 w-12 items-center justify-center rounded-full", active && "bg-blue-100")}><Icon aria-hidden="true" className="h-5 w-5" /></span><span>{t(item.href === "/settings/inbox" ? "admin.nav.email" : item.labelKey)}</span>
					</Link>;
				})}
				<Dialog.Trigger asChild>
					<button type="button" className={cn(targetClass, secondaryActive && "text-blue-800")} aria-label={t("settings.nav.menu")}>
						<span className={cn("flex h-7 w-12 items-center justify-center rounded-full", secondaryActive && "bg-blue-100")}><MoreHorizontal aria-hidden="true" className="h-5 w-5" /></span><span>{t("navigation.more")}</span>
					</button>
				</Dialog.Trigger>
			</div>
		</nav>
		<Dialog.Portal>
			<Dialog.Overlay className="dialog-overlay fixed inset-0 z-[140] bg-black/35" />
			<Dialog.Content aria-modal="true" aria-describedby={undefined} onCloseAutoFocus={event => {
				if (!window.matchMedia("(min-width: 768px)").matches) return;
				event.preventDefault();
				document.querySelector<HTMLElement>('[data-settings-desktop-nav] [aria-current="page"]')?.focus();
			}} className="settings-navigation-sheet fixed inset-x-0 bottom-0 z-[150] mx-auto flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-neutral-200 bg-white shadow-xl focus:outline-none" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)", paddingLeft: "env(safe-area-inset-left, 0px)", paddingRight: "env(safe-area-inset-right, 0px)" }}>
				<header className="shrink-0 px-5 pb-3 pt-5"><Dialog.Title className="text-lg font-semibold text-neutral-900">{t("settings.nav.settings")}</Dialog.Title></header>
				<div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-3">
					{settingsNavSections.map(section => <nav key={section.labelKey} aria-label={t(section.labelKey)} className="mb-3 last:mb-0">
						<h2 className="mb-1 px-2 text-xs font-medium text-neutral-500">{t(section.labelKey)}</h2>
						<div className="grid grid-cols-2 gap-2">
							{section.items.map(item => {
								const active = isActiveSettingsPath(pathname, item.href), Icon = icons[item.href];
								return <Link key={item.href} href={item.href} onClick={() => setOpen(false)} aria-current={active ? "page" : undefined} className={cn("flex min-h-12 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 motion-reduce:transition-none", active && "bg-blue-100 text-blue-900")}>
									<Icon aria-hidden="true" className="h-5 w-5 shrink-0" /><span className="min-w-0 break-words">{t(item.labelKey)}</span>
								</Link>;
							})}
						</div>
					</nav>)}
				</div>
				<footer className="shrink-0 border-t border-neutral-100 px-4 py-2"><Dialog.Close className="min-h-12 w-full rounded-xl bg-neutral-100 px-4 text-sm font-medium text-neutral-900 hover:bg-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">{t("navigation.close")}</Dialog.Close></footer>
			</Dialog.Content>
		</Dialog.Portal>
	</Dialog.Root>;
}
