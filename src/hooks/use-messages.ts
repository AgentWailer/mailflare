import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, MessageFilterOptions, MessageFolder, MessageListResponse } from "./types";
import { clearMessageCountsCache, clearMessageListCache, fetchMessageList, getCachedMessageList, getMessageQueryParams } from "./utils";
import { getClientSessionToken } from "@/lib/auth/client";
import { rememberStartList } from "@/lib/auth/early-requests";
import { classifyListFailure, listRetryDelay, type ListFailure } from "./list-failure";

const REFRESH_DEBOUNCE_MS = 150;
type ListState = { key: string; data: MessageListResponse; loading: boolean; refreshing: boolean; failed: boolean; failure?: ListFailure | null };

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
		let retryTimer: number | null = null;
		let failedTries = 0;
		const requestParams = new URLSearchParams(key);
		// A failed read is tried again by itself: a connection that drops for a moment (a laptop waking
		// up, a changed network) must not leave a notice behind that only the next new mail removes.
		// The first failure of a read nobody asked for is therefore silent; the notice appears when
		// the retry fails too, or at once when the reader pressed refresh or has to sign in again.
		async function load(force = false, origin: "event" | "reader" | "retry" = "event") {
			const request = ++requestNumber;
			if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = null; }
			if (origin !== "retry") failedTries = 0;
			const warm = getCachedMessageList(requestParams);
			setState(previous => ({ key, data: previous.key === key ? previous.data : warm ?? {}, loading: previous.key === key ? previous.loading || (!warm && !previous.data.messages && !previous.failed) : !warm, refreshing: force && origin !== "retry", failed: origin === "retry" && previous.key === key ? previous.failed : false, failure: origin === "retry" && previous.key === key ? previous.failure : null }));
			try {
				// The list a page shows first is what its next start asks for before the scripts have loaded.
				if (!force) rememberStartList(`/api/messages?${key}`, getClientSessionToken());
				const data = await fetchMessageList(requestParams, force);
				if (!cancelled && request === requestNumber) { failedTries = 0; setState({ key, data, loading: false, refreshing: false, failed: false, failure: null }); }
			} catch (error) {
				if (cancelled || request !== requestNumber) return;
				const failure = await classifyListFailure(error);
				if (cancelled || request !== requestNumber) return;
				failedTries++;
				const shown = origin === "reader" || failedTries > 1 || failure === "sign-in";
				setState(previous => shown
					? { ...previous, loading: false, refreshing: false, failed: true, failure }
					: { ...previous, refreshing: false });
				retryTimer = window.setTimeout(() => {
					retryTimer = null;
					// A hidden page tries again when it is looked at; the realtime hook announces that.
					if (document.visibilityState === "visible") void load(true, "retry");
				}, listRetryDelay(failedTries - 1));
			}
		}
		reload.current = async () => {
			clearMessageListCache();
			clearMessageCountsCache();
			window.dispatchEvent(new Event("mailflare:message-counts-changed"));
			await load(true, "reader");
		};
		void load();
		const onOnline = () => { void load(true); };
		window.addEventListener("online", onOnline);
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
			window.removeEventListener("online", onOnline);
			if (refreshTimer) window.clearTimeout(refreshTimer);
			if (retryTimer) window.clearTimeout(retryTimer);
		};
	}, [enabled, key]);

	const refresh = useCallback(() => reload.current(), []);
	const updateMessages = useCallback((update: Message[] | ((previous: Message[]) => Message[])) => {
		setState(previous => previous.key !== key ? previous : { ...previous, data: { ...previous.data, messages: typeof update === "function" ? update(previous.data.messages ?? []) : update } });
	}, [key]);
	const messages = current.data.messages ?? [];
	return { messages, unreadCount: messages.filter(m => m.direction === "inbound" && !m.read).length, isLoading: enabled && current.loading, isRefreshing: current.refreshing, error: current.failed, failure: current.failed ? current.failure ?? "connection" : null, total: current.data.total ?? 0, limit: current.data.limit ?? filters?.limit ?? 25, offset: current.data.offset ?? filters?.offset ?? 0, updateMessages, refresh };
}
