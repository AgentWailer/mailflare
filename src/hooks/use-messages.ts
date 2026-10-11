import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, MessageFilterOptions, MessageFolder, MessageListResponse } from "./types";
import { clearMessageCountsCache, clearMessageListCache, fetchMessageList, getCachedMessageList, getMessageQueryParams } from "./utils";

const REFRESH_DEBOUNCE_MS = 150;
type ListState = { key: string; data: MessageListResponse; loading: boolean; refreshing: boolean; failed: boolean };

export function useMessages(folder: MessageFolder, mailboxId?: string | null, filters?: MessageFilterOptions, enabled = true, folderId?: string | null) {
	const params = getMessageQueryParams(folder, mailboxId, filters, folderId);
	const key = params.toString();
	const cached = getCachedMessageList(params);
	const [state, setState] = useState<ListState>(() => ({ key, data: cached ?? {}, loading: enabled && !cached, refreshing: false, failed: false }));
	const reload = useRef<() => Promise<void>>(async () => {});
	// Never show another mailbox/category's data while its new request is pending.
	const current = state.key === key ? state : { key, data: cached ?? {}, loading: enabled && !cached, refreshing: false, failed: false };

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let refreshTimer: number | null = null;
		let requestNumber = 0;
		const requestParams = new URLSearchParams(key);
		async function load(force = false) {
			const request = ++requestNumber;
			const warm = getCachedMessageList(requestParams);
			setState(previous => ({ key, data: previous.key === key ? previous.data : warm ?? {}, loading: previous.key === key ? previous.loading || (!warm && !previous.data.messages && !previous.failed) : !warm, refreshing: force, failed: false }));
			try {
				const data = await fetchMessageList(requestParams, force);
				if (!cancelled && request === requestNumber) setState({ key, data, loading: false, refreshing: false, failed: false });
			} catch {
				if (!cancelled && request === requestNumber) setState(previous => ({ ...previous, loading: false, refreshing: false, failed: true }));
			}
		}
		reload.current = async () => {
			clearMessageListCache();
			clearMessageCountsCache();
			window.dispatchEvent(new Event("mailflare:message-counts-changed"));
			await load(true);
		};
		void load();
		function onMessagesChanged() {
			clearMessageListCache();
			clearMessageCountsCache();
			if (document.visibilityState !== "visible") return;
			if (refreshTimer) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(() => { refreshTimer = null; void load(true); }, REFRESH_DEBOUNCE_MS);
		}
		window.addEventListener("mailflare:messages-changed", onMessagesChanged);
		return () => {
			cancelled = true;
			reload.current = async () => {};
			window.removeEventListener("mailflare:messages-changed", onMessagesChanged);
			if (refreshTimer) window.clearTimeout(refreshTimer);
		};
	}, [enabled, key]);

	const refresh = useCallback(() => reload.current(), []);
	const updateMessages = useCallback((update: Message[] | ((previous: Message[]) => Message[])) => {
		setState(previous => previous.key !== key ? previous : { ...previous, data: { ...previous.data, messages: typeof update === "function" ? update(previous.data.messages ?? []) : update } });
	}, [key]);
	const messages = current.data.messages ?? [];
	return { messages, unreadCount: messages.filter(m => m.direction === "inbound" && !m.read).length, isLoading: enabled && current.loading, isRefreshing: current.refreshing, error: current.failed, total: current.data.total ?? 0, limit: current.data.limit ?? filters?.limit ?? 25, offset: current.data.offset ?? filters?.offset ?? 0, updateMessages, refresh };
}
