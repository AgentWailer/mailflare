"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Inbox, Megaphone, Users, ReceiptText, Package } from "lucide-react";
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
	const strip = useRef<HTMLDivElement>(null);
	const [edges, setEdges] = useState({ overflow: false, start: true, end: true });
	function measure() {
		const el = strip.current;
		if (!el) return;
		const offset = Math.abs(el.scrollLeft);
		const next = { overflow: el.scrollWidth > el.clientWidth + 1, start: offset <= 1, end: offset + el.clientWidth >= el.scrollWidth - 1 };
		setEdges(previous => previous.overflow === next.overflow && previous.start === next.start && previous.end === next.end ? previous : next);
	}
	function revealActiveTab() {
		const el = strip.current;
		const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
		if (!el || !active) return;
		// Scroll only this strip, including after font size or viewport changes.
		const box = el.getBoundingClientRect(), tab = active.getBoundingClientRect();
		if (tab.left < box.left) el.scrollLeft -= box.left - tab.left;
		else if (tab.right > box.right) el.scrollLeft += tab.right - box.right;
	}
	useEffect(() => {
		const el = strip.current;
		if (!el) return;
		const observer = new ResizeObserver(() => { revealActiveTab(); measure(); });
		observer.observe(el);
		// Text can grow while the strip's own width stays unchanged.
		for (const tab of el.children) observer.observe(tab);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		revealActiveTab();
		measure();
	}, [folder, edges.overflow]);
	function scrollTabs(direction: number) {
		const el = strip.current;
		if (el) el.scrollBy({ left: direction * (getComputedStyle(el).direction === "rtl" ? -1 : 1) * el.clientWidth * .8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
	}
	function warm(category: MessageFolder) {
		if (!selectedMailbox || isLoading) return;
		void fetchMessageList(getMessageQueryParams(category, selectedMailbox.id, { query, limit: 25, group: conversationView ? "thread" : undefined })).catch(() => {});
	}
	return <nav data-inbox-categories aria-label={t("smart.category")} className="flex min-w-0 shrink-0 border-b border-neutral-200">
		{edges.overflow && <button type="button" aria-label={t("message.categories.previous")} disabled={edges.start} onClick={() => scrollTabs(-1)} className="mail-category-scroll"><ChevronLeft aria-hidden="true" className="h-4 w-4" /></button>}
		<div ref={strip} onScroll={measure} className="mail-category-strip flex min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
		{categories.map(({ folder: category, href, label, icon: Icon }) => <Link key={category} data-category-tab={category} href={href} prefetch={false} scroll={false} onPointerEnter={() => warm(category)} onFocus={() => warm(category)} onTouchStart={() => warm(category)} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (folder !== category) router.push(href, { scroll: false }); }} aria-current={folder === category ? "page" : undefined} title={t(label)} className={`flex min-h-11 min-w-max flex-[1_0_auto] items-center justify-center gap-2 whitespace-nowrap border-b-2 px-3 text-xs sm:text-sm ${compact ? "flex-col gap-0.5 py-1" : ""} ${folder === category ? "border-blue-600 font-medium text-blue-700" : "border-transparent text-neutral-600 hover:bg-neutral-50"}`}><Icon className={`h-4 w-4 shrink-0 ${compact ? "hidden" : "max-sm:hidden"}`} /><span className="shrink-0 text-center leading-4">{t(label)}</span></Link>)}
		</div>
		{edges.overflow && <button type="button" aria-label={t("message.categories.next")} disabled={edges.end} onClick={() => scrollTabs(1)} className="mail-category-scroll"><ChevronRight aria-hidden="true" className="h-4 w-4" /></button>}
		{onRefresh && <MessageRefreshButton onRefresh={onRefresh} refreshing={refreshing} disabled={disabled} />}
	</nav>;
}
