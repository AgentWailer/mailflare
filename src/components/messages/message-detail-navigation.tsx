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

const NavigationContext = createContext<MessageDetailNavigationContextValue | null>(null);

export function MessageDetailNavigationProvider({ children, config }: MessageDetailNavigationProviderProps) {
	const { selectedMailbox, isLoading: mailboxesLoading } = useSelectedMailbox();
	const [conversationView] = useConversationView();
	const { query } = useMailSearch();
	const grouped = conversationView && config.folder !== "drafts";
	const mailboxId = selectedMailbox?.id;
	const key = JSON.stringify([config.folder, config.folderId, mailboxId, grouped, query]);
	const [snapshot, setSnapshot] = useState<MessageDetailNavigationSnapshot>({ key: "", entries: [] });
	useEffect(() => {
		if (mailboxesLoading) return;
		let cancelled = false;
		let requestNumber = 0;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		const params = new URLSearchParams({ folder: config.folder });
		if (query.trim()) params.set("q", query);
		if (config.folderId) params.set("folderId", config.folderId);
		if (mailboxId) params.set("mailboxId", mailboxId);
		if (grouped) params.set("group", "thread");
		async function load() {
			const request = ++requestNumber;
			try {
				const response = await authFetch(`/api/messages/navigation?${params.toString()}`, { cache: "no-store" });
				if (!response.ok) throw new Error("Unable to load message navigation");
				const data = await response.json() as MessageNavigationResponse;
				if (!cancelled && request === requestNumber) setSnapshot({ key, entries: data.messages });
			} catch { /* Retain navigation during a temporary connection failure. */ }
		}
		function scheduleLoad() {
			requestNumber++;
			clearTimeout(refreshTimer);
			if (document.visibilityState !== "visible") return;
			refreshTimer = setTimeout(() => { void load(); }, 150);
		}
		void load();
		window.addEventListener("mailflare:messages-changed", scheduleLoad);
		window.addEventListener("mailflare:message-counts-changed", scheduleLoad);
		window.addEventListener("focus", scheduleLoad);
		window.addEventListener("pageshow", scheduleLoad);
		document.addEventListener("visibilitychange", scheduleLoad);
		return () => {
			cancelled = true;
			clearTimeout(refreshTimer);
			window.removeEventListener("mailflare:messages-changed", scheduleLoad);
			window.removeEventListener("mailflare:message-counts-changed", scheduleLoad);
			window.removeEventListener("focus", scheduleLoad);
			window.removeEventListener("pageshow", scheduleLoad);
			document.removeEventListener("visibilitychange", scheduleLoad);
		};
	}, [config.folder, config.folderId, grouped, key, mailboxId, mailboxesLoading, query]);

	const entries = snapshot.key === key ? snapshot.entries : [];
	return <NavigationContext.Provider value={{ entries, hrefPrefix: config.hrefPrefix }}>{children}</NavigationContext.Provider>;
}

export function MessageDetailNavigation({ messageId }: MessageDetailNavigationProps) {
	const { t } = useLanguage();
	const context = useContext(NavigationContext);
	const router = useRouter();
	if (!context) return null;
	const { previousId, nextId, position, total } = getMessageDetailNavigationState(context.entries, messageId);

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
