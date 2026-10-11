import { useEffect, useState } from "react";
import type { MessageCounts, MessageCountsDelta } from "./types";
import { clearMessageCountsCache, fetchMessageCounts } from "./utils";

const REFRESH_DEBOUNCE_MS = 150;

const emptyCounts: MessageCounts = {
	folders: {
		inbox: { total: 0, unread: 0 },
		promotions: { total: 0, unread: 0 },
		social: { total: 0, unread: 0 },
		starred: { total: 0, unread: 0 },
		all: { total: 0, unread: 0 },
		snoozed: { total: 0, unread: 0 },
		sent: { total: 0, unread: 0 },
		scheduled: { total: 0, unread: 0 },
		drafts: { total: 0, unread: 0 },
		archived: { total: 0, unread: 0 },
		spam: { total: 0, unread: 0 },
		trash: { total: 0, unread: 0 },
	},
	customFolders: {},
	mailboxes: [],
};

export function useMessageCounts(mailboxId?: string | null, enabled = true) {
	const key = mailboxId ?? "all";
	const [snapshot, setSnapshot] = useState({ key, counts: emptyCounts });
	const [isLoading, setIsLoading] = useState(enabled);

	useEffect(() => {
		if (!enabled) return;

		let cancelled = false;
		let refreshTimer: number | null = null;
		let requestNumber = 0;

		async function loadCounts(force = false) {
			const currentRequest = ++requestNumber;
			setIsLoading(true);
			try {
				const nextCounts = await fetchMessageCounts(mailboxId, force);
				if (!cancelled && currentRequest === requestNumber) setSnapshot({ key, counts: nextCounts ?? emptyCounts });
			} catch {
				// Retain the last counts when a mobile connection temporarily drops.
			} finally {
				if (!cancelled && currentRequest === requestNumber) setIsLoading(false);
			}
		}

		void loadCounts();
		function onMessagesChanged() {
			// Invalidate pending responses before the debounce, not when the next fetch starts.
			requestNumber++;
			clearMessageCountsCache();
			if (refreshTimer) window.clearTimeout(refreshTimer);
			if (document.visibilityState !== "visible") return;
			refreshTimer = window.setTimeout(() => {
				refreshTimer = null;
				void loadCounts(true);
			}, REFRESH_DEBOUNCE_MS);
		}
		function onMessageCountsDelta(event: Event) {
			const detail = (event as CustomEvent<MessageCountsDelta>).detail;
			if (mailboxId && detail?.mailboxId && detail.mailboxId !== mailboxId) return;
			const delta = detail?.inboxUnreadDelta;
			if (typeof delta !== "number" || !Number.isFinite(delta) || !delta) return;
			requestNumber++;
			clearMessageCountsCache();
			setSnapshot((current) => {
				if (current.key !== key) return current;
				const counts = current.counts;
				return { key, counts: {
					...counts,
					folders: {
						...counts.folders,
						inbox: {
							...counts.folders.inbox,
							unread: Math.max(0, counts.folders.inbox.unread + delta),
						},
					},
				}};
			});
		}
		window.addEventListener("mailflare:messages-changed", onMessagesChanged);
		window.addEventListener("mailflare:message-counts-changed", onMessagesChanged);
		window.addEventListener("mailflare:message-counts-delta", onMessageCountsDelta);
		function onVisible() {
			if (document.visibilityState === "visible") onMessagesChanged();
		}
		window.addEventListener("focus", onVisible);
		window.addEventListener("pageshow", onVisible);
		document.addEventListener("visibilitychange", onVisible);

		return () => {
			cancelled = true;
			window.removeEventListener("mailflare:messages-changed", onMessagesChanged);
			window.removeEventListener("mailflare:message-counts-changed", onMessagesChanged);
			window.removeEventListener("mailflare:message-counts-delta", onMessageCountsDelta);
			window.removeEventListener("focus", onVisible);
			window.removeEventListener("pageshow", onVisible);
			document.removeEventListener("visibilitychange", onVisible);
			if (refreshTimer) window.clearTimeout(refreshTimer);
		};
	}, [enabled, mailboxId, key]);

	return { counts: enabled && snapshot.key === key ? snapshot.counts : emptyCounts, isLoading: enabled && (snapshot.key !== key || isLoading) };
}
