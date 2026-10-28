"use client";

import { useBranding } from "./branding-provider";
import clsx from "clsx";
import { usePathname } from "next/navigation";
import { Settings, Sparkles } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { MobileMenuButton } from "@/components/sidebar-aside";
import { MailSearchInput } from "@/components/mail-search/mail-search-input";
import { MailboxSelector } from "@/components/mailbox-selector";
import { ThemeToggle } from "@/components/theme-toggle";

export function MailHeader({ assistantEnabled, assistantOpen, onToggleAssistant, quickSettingsOpen = false, onToggleQuickSettings }: { assistantEnabled: boolean | null; assistantOpen: boolean; onToggleAssistant: () => void; quickSettingsOpen?: boolean; onToggleQuickSettings?: () => void }) {
	const { t } = useLanguage();
	const branding = useBranding();
	const pathname = usePathname();
	const readingMessage = /^\/(inbox|all|promotions|social|invoices|orders|starred|snoozed|sent|scheduled|archived|spam|trash)\/[^/]+\/?$/.test(pathname) || /^\/folders\/[^/]+\/[^/]+\/?$/.test(pathname);
	return (
		<header data-reading-message={readingMessage && !assistantOpen} className={clsx("mail-mobile-header flex h-16 w-full shrink-0 items-center gap-3 pr-4 text-sm max-md:gap-1 max-md:pr-2", readingMessage && !assistantOpen && "max-lg:hidden")}>
			<MobileMenuButton className="mail-header-menu ml-2" />
			<span className="mail-mobile-wordmark hidden">{branding.appName}</span>
			<MailSearchInput />
			<div data-mail-header-actions className="ml-auto flex shrink-0 items-center gap-1 md:gap-2">
			{assistantEnabled && <Button type="button" variant="ghost" size="sm" className={clsx("hidden h-11 w-11 shrink-0 rounded-full px-0 md:flex", assistantOpen ? "bg-blue-50 text-blue-700" : "text-neutral-600")} onClick={onToggleAssistant} aria-label={assistantOpen ? t("agent.assistant.close") : t("agent.assistant.open")} aria-expanded={assistantOpen} aria-controls="email-assistant-panel"><Sparkles className="h-5 w-5" /></Button>}
			{onToggleQuickSettings && <Button id="mail-quick-settings-toggle" type="button" variant="ghost" size="sm" className={clsx("flex h-11 w-11 shrink-0 items-center justify-center rounded-full p-0", quickSettingsOpen ? "bg-blue-50 text-blue-700" : "text-neutral-600")} onClick={onToggleQuickSettings} aria-label={t("settings.quick.title")} title={t("settings.quick.title")} aria-expanded={quickSettingsOpen} aria-controls="mail-quick-settings"><Settings className="h-5 w-5" /></Button>}
			<div className={onToggleQuickSettings ? "hidden md:block" : ""}><ThemeToggle /></div>
			<MailboxSelector onToggleAssistant={assistantEnabled ? onToggleAssistant : undefined} assistantOpen={assistantOpen} />
			</div>
		</header>
	);
}
