"use client";

import clsx from "clsx";
import { usePathname } from "next/navigation";
import { Sparkles } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { MobileMenuButton } from "@/components/sidebar-aside";
import { MailSearchInput } from "@/components/mail-search/mail-search-input";
import { MailboxSelector } from "@/components/mailbox-selector";
import { ThemeToggle } from "@/components/theme-toggle";

export function MailHeader({ assistantEnabled, assistantOpen, onToggleAssistant }: { assistantEnabled: boolean | null; assistantOpen: boolean; onToggleAssistant: () => void }) {
	const { t } = useLanguage();
	const pathname = usePathname();
	const readingMessage = /^\/(inbox|all|promotions|social|starred|snoozed|sent|scheduled|archived|spam|trash)\/[^/]+\/?$/.test(pathname) || /^\/folders\/[^/]+\/[^/]+\/?$/.test(pathname);
	return (
		<header className={clsx("mail-mobile-header flex h-16 w-full shrink-0 items-center gap-3 pr-4 text-sm max-md:gap-1 max-md:pr-2", readingMessage && !assistantOpen && "max-lg:hidden")}>
			<MobileMenuButton className="ml-2" />
			<MailSearchInput />
			{assistantEnabled && <Button type="button" variant="ghost" size="sm" className={clsx("hidden h-11 w-11 shrink-0 rounded-full px-0 md:flex", assistantOpen ? "bg-blue-50 text-blue-700" : "text-neutral-600")} onClick={onToggleAssistant} aria-label={assistantOpen ? t("agent.assistant.close") : t("agent.assistant.open")} aria-expanded={assistantOpen} aria-controls="email-assistant-panel"><Sparkles className="h-5 w-5" /></Button>}
			<MailboxSelector onToggleAssistant={assistantEnabled ? onToggleAssistant : undefined} assistantOpen={assistantOpen} />
			<ThemeToggle />
		</header>
	);
}
