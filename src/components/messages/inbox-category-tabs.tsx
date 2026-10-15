"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Inbox, Megaphone, Users, ReceiptText, Package } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import type { MessageFolder } from "@/hooks/types";
import type { TranslationKey } from "@/lib/i18n/types";
import { MessageRefreshButton } from "./message-refresh-button";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { useConversationView } from "./use-conversation-view";
import { fetchMessageList, getMessageQueryParams } from "@/hooks/utils";

const categories: Array<{ folder: MessageFolder; href: string; label: TranslationKey; icon: typeof Inbox }> = [
	{ folder: "inbox", href: "/inbox", label: "message.categories.primary", icon: Inbox },
	{ folder: "invoices", href: "/invoices", label: "smart.invoices", icon: ReceiptText },
	{ folder: "promotions", href: "/promotions", label: "smart.promotions", icon: Megaphone },
	{ folder: "social", href: "/social", label: "message.categories.social", icon: Users },
	{ folder: "orders", href: "/orders", label: "smart.orders", icon: Package },
];

export function InboxCategoryTabs({ folder, compact = false, onRefresh, refreshing = false, disabled = false }: { folder: MessageFolder; compact?: boolean; onRefresh?: () => Promise<void>; refreshing?: boolean; disabled?: boolean }) {
	const { t } = useLanguage();
	const router = useRouter();
	const { selectedMailbox, isLoading } = useSelectedMailbox();
	const { query } = useMailSearch();
	const [conversationView] = useConversationView();
	function warm(category: MessageFolder) {
		if (!selectedMailbox || isLoading) return;
		void fetchMessageList(getMessageQueryParams(category, selectedMailbox.id, { query, limit: 25, group: conversationView ? "thread" : undefined })).catch(() => {});
	}
	return <nav data-inbox-categories aria-label={t("smart.category")} className="flex min-w-0 shrink-0 border-b border-neutral-200">
		<div className="flex min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
		{categories.map(({ folder: category, href, label, icon: Icon }) => <Link key={category} href={href} prefetch={false} scroll={false} onPointerEnter={() => warm(category)} onFocus={() => warm(category)} onTouchStart={() => warm(category)} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (folder !== category) router.push(href, { scroll: false }); }} aria-current={folder === category ? "page" : undefined} title={t(label)} className={`flex min-h-11 min-w-24 flex-1 shrink-0 items-center justify-center gap-2 border-b-2 px-2 text-xs sm:text-sm ${compact ? "flex-col gap-0.5 py-1" : ""} ${folder === category ? "border-blue-600 font-medium text-blue-700" : "border-transparent text-neutral-600 hover:bg-neutral-50"}`}><Icon className={`h-4 w-4 shrink-0 ${compact ? "hidden" : "max-sm:hidden"}`} /><span className="min-w-0 text-center leading-4">{t(label)}</span></Link>)}
		</div>
		{onRefresh && <MessageRefreshButton onRefresh={onRefresh} refreshing={refreshing} disabled={disabled} />}
	</nav>;
}
