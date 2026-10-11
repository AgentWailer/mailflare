"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { useMessages } from "@/hooks/use-messages";
import { useConversationView } from "./use-conversation-view";
import type { ReadingLayout } from "./use-reading-layout";
import { readReadingLayout } from "./use-reading-layout";
import type { MessageFolderConfig } from "./types";

const desktopQuery = "(min-width: 1024px)";
function subscribeViewport(changed: () => void) {
	const media = window.matchMedia(desktopQuery);
	media.addEventListener("change", changed);
	return () => media.removeEventListener("change", changed);
}
const desktopSnapshot = () => window.matchMedia(desktopQuery).matches;
const serverSnapshot = () => false;

/** Fill an enabled desktop reading pane without taking phones out of their inbox. */
export function useInitialMessagePreview({ config, readingLayout, selectedMessageId, offset, unreadOnly }: {
	config: MessageFolderConfig;
	readingLayout: ReadingLayout;
	selectedMessageId?: string;
	offset: number;
	unreadOnly: boolean;
}) {
	const pathname = usePathname(), router = useRouter();
	const desktop = useSyncExternalStore(subscribeViewport, desktopSnapshot, serverSnapshot);
	const { selectedMailbox, isLoading: mailboxesLoading } = useSelectedMailbox();
	const { query } = useMailSearch();
	const [conversationView] = useConversationView();
	const enabled = desktop && readingLayout !== "off" && !selectedMessageId
		&& pathname === config.hrefPrefix && config.folder !== "drafts" && !mailboxesLoading;
	// The list uses the same cached request, so preview selection does not fetch a second list.
	const { messages, isLoading, error } = useMessages(config.folder, selectedMailbox?.id, {
		query, limit: 25, offset, read: unreadOnly ? "unread" : "all",
		group: conversationView && config.folder !== "drafts" ? "thread" : undefined,
	}, enabled, config.folderId);
	const firstId = messages[0]?.id;
	useEffect(() => {
		if (!enabled || isLoading || error || !firstId) return;
		// The preference hook hydrates in a layout effect. Its first render can still
		// say "bottom" while the saved preference is "off"; never navigate from that render.
		if (readReadingLayout() === "off" || window.location.pathname !== config.hrefPrefix) return;
		// Replace the folder's empty-preview entry instead of adding an extra Back step.
		router.replace(`${config.hrefPrefix}/${firstId}${window.location.search}`, { scroll: false });
	}, [enabled, isLoading, error, firstId, config.hrefPrefix, router]);
}
