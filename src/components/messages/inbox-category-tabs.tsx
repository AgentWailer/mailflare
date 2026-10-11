"use client";

import Link from "next/link";
import { Inbox, Megaphone, Users } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import type { MessageFolder } from "@/hooks/types";
import type { TranslationKey } from "@/lib/i18n/types";

const categories: Array<{ folder: MessageFolder; href: string; label: TranslationKey; icon: typeof Inbox }> = [
	{ folder: "inbox", href: "/inbox", label: "message.categories.primary", icon: Inbox },
	{ folder: "promotions", href: "/promotions", label: "smart.promotions", icon: Megaphone },
	{ folder: "social", href: "/social", label: "message.categories.social", icon: Users },
];

export function InboxCategoryTabs({ folder, compact = false }: { folder: MessageFolder; compact?: boolean }) {
	const { t } = useLanguage();
	return <nav data-inbox-categories aria-label={t("smart.category")} className="grid shrink-0 grid-cols-3 border-b border-neutral-200">
		{categories.map(({ folder: category, href, label, icon: Icon }) => <Link key={category} href={href} aria-current={folder === category ? "page" : undefined} title={t(label)} className={`flex min-h-11 min-w-0 items-center justify-center gap-2 border-b-2 px-2 text-xs sm:text-sm ${compact ? "flex-col gap-0.5 py-1" : ""} ${folder === category ? "border-blue-600 font-medium text-blue-700" : "border-transparent text-neutral-600 hover:bg-neutral-50"}`}><Icon className={`h-4 w-4 shrink-0 ${compact ? "hidden" : "max-sm:hidden"}`} /><span className="min-w-0 text-center leading-4">{t(label)}</span></Link>)}
	</nav>;
}
