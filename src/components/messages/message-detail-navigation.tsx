"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { authFetch } from "@/lib/auth/client";
import type { MessageNavigationResponse } from "@/app/api/messages/navigation/types";
import type { MessageDetailNavigationContextValue, MessageDetailNavigationProps, MessageDetailNavigationProviderProps, MessageDetailNavigationSnapshot } from "./message-detail-navigation-types";
import { getMessageDetailNavigationState } from "./message-detail-navigation-utils";
import { useConversationView } from "./use-conversation-view";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { getCachedMessageList, getMessageQueryParams } from "@/hooks/utils";
import { useMessageSelection } from "./message-selection-context";
import { parseSearchQuery } from "@/lib/search/query-utils";

const NavigationContext = createContext<MessageDetailNavigationContextValue | null>(null);

export function MessageDetailNavigationProvider({ children, config, messageId }: MessageDetailNavigationProviderProps) {
	const { selectedMailbox, isLoading: mailboxesLoading } = useSelectedMailbox();
	const [conversationView] = useConversationView();
	const { query } = useMailSearch();
	const selection = useMessageSelection();
	const offset = selection?.offset ?? 0, unreadOnly = selection?.unreadOnly ?? false;
	const grouped = conversationView && config.folder !== "drafts";
	const mailboxId = selectedMailbox?.id;
	const key = JSON.stringify([config.folder, config.folderId, mailboxId, grouped, query, messageId, offset, unreadOnly]);
	const pageParams = getMessageQueryParams(config.folder, mailboxId, { query, read: unreadOnly ? "unread" : "all", offset, limit: 25, group: grouped ? "thread" : undefined }, config.folderId);
	const pageKey = pageParams.toString();
	function cachedWindow() {
		if (!messageId || mailboxesLoading) return undefined;
		const page = getCachedMessageList(new URLSearchParams(pageKey)), rows = page?.messages ?? [];
		const index = rows.findIndex(row => row.id === messageId), start = page?.offset ?? offset, total = page?.total ?? rows.length;
		// At a page boundary an unknown neighbour must come from the server.
		if (index < 0 || index === 0 && start > 0 || index === rows.length - 1 && start + rows.length < total) return undefined;
		return { previousId: rows[index - 1]?.id ?? null, nextId: rows[index + 1]?.id ?? null, position: start + index + 1, total };
	}
	const cached = cachedWindow();
	const [snapshot, setSnapshot] = useState<MessageDetailNavigationSnapshot>({ key: "", entries: [] });
	useEffect(() => {
		if (mailboxesLoading) return;
		let cancelled = false;
		let requestNumber = 0;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		const params = new URLSearchParams({ folder: config.folder });
		if (query.trim()) params.set("q", query);
		if (messageId) params.set("messageId", messageId);
		if (config.folderId) params.set("folderId", config.folderId);
		if (mailboxId) params.set("mailboxId", mailboxId);
		if (grouped) params.set("group", "thread");
		if (unreadOnly) params.set("read", "unread");
		params.set("timeZone", new URLSearchParams(pageKey).get("timeZone") ?? "UTC");
		async function load(force = false) {
			const request = ++requestNumber;
			const warm = !force && cachedWindow();
			if (warm) { setSnapshot({ key, entries: [], navigation: warm }); return; }
			try {
				const response = await authFetch(`/api/messages/navigation?${params.toString()}`, { cache: "no-store" });
				if (!response.ok) throw new Error("Unable to load message navigation");
				const data = await response.json() as MessageNavigationResponse;
				if (!cancelled && request === requestNumber) setSnapshot({ key, entries: data.messages, navigation: data.navigation });
			} catch { /* Retain navigation during a temporary connection failure. */ }
		}
		function scheduleLoad() {
			requestNumber++;
			clearTimeout(refreshTimer);
			if (document.visibilityState !== "visible") return;
			refreshTimer = setTimeout(() => { void load(true); }, 150);
		}
		function onCountsChanged() {
			if (!messageId || unreadOnly || parseSearchQuery(query).read) scheduleLoad();
		}
		void load();
		window.addEventListener("mailflare:messages-changed", scheduleLoad);
		window.addEventListener("mailflare:message-counts-changed", onCountsChanged);
		window.addEventListener("focus", scheduleLoad);
		window.addEventListener("pageshow", scheduleLoad);
		document.addEventListener("visibilitychange", scheduleLoad);
		return () => {
			cancelled = true;
			clearTimeout(refreshTimer);
			window.removeEventListener("mailflare:messages-changed", scheduleLoad);
			window.removeEventListener("mailflare:message-counts-changed", onCountsChanged);
			window.removeEventListener("focus", scheduleLoad);
			window.removeEventListener("pageshow", scheduleLoad);
			document.removeEventListener("visibilitychange", scheduleLoad);
		};
	// cachedWindow only reads the session-scoped list identified by pageKey.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [config.folder, config.folderId, grouped, key, mailboxId, mailboxesLoading, query, messageId, pageKey, unreadOnly]);

	const entries = snapshot.key === key ? snapshot.entries : [];
	return <NavigationContext.Provider value={{ entries, navigation: snapshot.key === key ? snapshot.navigation : cached, hrefPrefix: config.hrefPrefix }}>{children}</NavigationContext.Provider>;
}

export function MessageDetailNavigation({ messageId }: MessageDetailNavigationProps) {
	const { t } = useLanguage();
	const context = useContext(NavigationContext);
	const router = useRouter();
	if (!context) return null;
	const { previousId, nextId, position, total } = context.navigation ?? getMessageDetailNavigationState(context.entries, messageId);

	return (
		<div className="ml-auto hidden shrink-0 items-center gap-2 text-neutral-500 md:flex">
			{position > 0 && (
			<span className="mr-2 whitespace-nowrap text-xs" aria-live="polite">
					{t("message.nav.position", { position, total })}
			</span>
			)}
			<Tooltip label={t("message.nav.newer")}>
				<Button type="button" variant="ghost" size="roundedSM" aria-label={t("message.nav.newer")} disabled={!previousId} onClick={() => previousId && router.push(`${context.hrefPrefix}/${previousId}`)}>
					<ChevronLeft size={18} />
				</Button>
			</Tooltip>
			<Tooltip label={t("message.nav.older")}>
				<Button type="button" variant="ghost" size="roundedSM" aria-label={t("message.nav.older")} disabled={!nextId} onClick={() => nextId && router.push(`${context.hrefPrefix}/${nextId}`)}>
					<ChevronRight size={18} />
				</Button>
			</Tooltip>
		</div>
	);
}
