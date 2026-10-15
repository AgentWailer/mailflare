import { getMessageFolderParams } from "@/lib/messages/folder-params";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";
import { parseSearchQuery } from "@/lib/search/query-utils";
import { getUserTimeZone } from "@/lib/time/utils";
import { setCachedMessageRead } from "@/lib/messages/detail-cache";
import type { MessageFilterOptions, MessageFolder } from "./types";
import type { MessageCounts, MessageListResponse } from "./types";

/**
 * The search string goes to the server whole; operators are parsed there
 * against the full-text index. Only the read state is lifted out here so the
 * unread toggle and `is:unread` share one `read` parameter.
 */
export function parseMessageSearchQuery(query: string): MessageFilterOptions {
	const parsed = parseSearchQuery(query);
	const filters: MessageFilterOptions = {};
	if (parsed.read) filters.read = parsed.read;
	const remaining = query.replace(/(^|\s)(is:(un)?read|:(un)?read)(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
	if (remaining) filters.query = remaining;
	return filters;
}

export function getMessageQueryParams(
	folder: MessageFolder,
	mailboxId?: string | null,
	filters?: MessageFilterOptions,
	folderId?: string | null,
) {
	const params = getMessageFolderParams(folder, mailboxId, folderId);
	params.set("timeZone", getUserTimeZone());
	const searchFilters = filters?.query ? parseMessageSearchQuery(filters.query) : null;
	const parsedFilters = searchFilters
		? { ...filters, ...searchFilters, read: filters?.read ?? searchFilters.read }
		: filters;
	if (parsedFilters?.query?.trim()) params.set("q", parsedFilters.query.trim());
	if (parsedFilters?.title?.trim()) params.set("title", parsedFilters.title.trim());
	if (parsedFilters?.read && parsedFilters.read !== "all") params.set("read", parsedFilters.read);
	if (filters?.limit) params.set("limit", String(filters.limit));
	if (filters?.offset) params.set("offset", String(filters.offset));
	if (filters?.group) params.set("group", filters.group);

	return params;
}

const messageCountsCache = new Map<string, MessageCounts>();
const messageCountsRequests = new Map<string, { promise: Promise<MessageCounts | undefined>; generation: number }>();
const messageListCache = new Map<string, MessageListResponse>();
const prefetchedMessageListAt = new Map<string, number>();
const messageListRequests = new Map<string, { promise: Promise<MessageListResponse>; generation: number }>();
let messageCacheGeneration = 0;
let messageCountsGeneration = 0;
let messageClientGeneration = 0;
let messageClientToken: string | null = null;

export function clearMessageCountsCache() {
	messageCountsGeneration += 1;
	messageCountsCache.clear();
	// Keep in-flight requests: multiple refresh listeners must not start overlapping
	// archive-wide aggregates. A changed generation schedules one fresh follow-up.
}

export function clearMessageListCache() {
	messageCacheGeneration += 1;
	messageListCache.clear();
	prefetchedMessageListAt.clear();
	// Retain pending requests so multiple listeners schedule only one fresh follow-up.
}

/**
 * Mirror a read/unread change into the cached lists and details, so a list
 * remounted later (or a detail reopened) never shows the old state.
 */
export function markMessagesReadInCaches(messageIds: string[], read: boolean) {
	const ids = new Set(messageIds);
	for (const [key, response] of messageListCache) {
		if (!response.messages?.some((message) => ids.has(message.id))) continue;
		messageListCache.set(key, {
			...response,
			messages: response.messages.map((message) => {
				if (!ids.has(message.id)) return message;
				const threadSize = message.threadMessageIds?.length;
				return {
					...message,
					read,
					...(threadSize !== undefined ? { threadUnread: read ? 0 : threadSize } : {}),
				};
			}),
		});
	}
	for (const id of ids) setCachedMessageRead(id, read);
	// Quiet list actions still need to reconcile every unread counter with the server.
	clearMessageCountsCache();
	if (typeof window !== "undefined") window.dispatchEvent(new Event("mailflare:message-counts-changed"));
}

// Caches must drop on every change, including ones made while no list is mounted
// (e.g. reading a message from the popup on a page without the inbox list).
if (typeof window !== "undefined") {
	window.addEventListener("mailflare:messages-changed", () => {
		clearMessageListCache();
		clearMessageCountsCache();
	});
}

export function clearMessageClientState() {
	messageClientToken = getClientSessionToken();
	messageClientGeneration += 1;
	messageCacheGeneration += 1;
	messageCountsGeneration += 1;
	messageCountsCache.clear();
	messageCountsRequests.clear();
	messageListCache.clear();
	prefetchedMessageListAt.clear();
	messageListRequests.clear();
}

function ensureMessageClientSession() {
	if (messageClientToken !== getClientSessionToken()) clearMessageClientState();
}

export function getMessageClientGeneration() {
	ensureMessageClientSession();
	return messageClientGeneration;
}

/** Let foreground lists and counters finish before starting speculative work. */
export function hasPendingMessageRequests() {
	ensureMessageClientSession();
	return messageListRequests.size > 0 || messageCountsRequests.size > 0;
}

export async function fetchMessageCounts(mailboxId?: string | null, force = false): Promise<MessageCounts | undefined> {
	ensureMessageClientSession();
	const requestToken = getClientSessionToken();
	const key = mailboxId ?? "all";
	if (!force && messageCountsCache.has(key)) return messageCountsCache.get(key);
	const pending = messageCountsRequests.get(key);
	if (pending) {
		if (pending.generation === messageCountsGeneration) return pending.promise;
		return pending.promise.catch(() => undefined).then(() => fetchMessageCounts(mailboxId, true));
	}

	const requestGeneration = messageCacheGeneration;
	const countsGeneration = messageCountsGeneration;
	const request = (async () => {
		const params = new URLSearchParams();
		if (mailboxId) params.set("mailboxId", mailboxId);
		const query = params.toString();
		const res = await authFetch(`/api/messages/counts${query ? `?${query}` : ""}`, { cache: force ? "no-store" : "default" });
		if (!res.ok) throw new Error(`Message counts request failed (${res.status})`);
		const data = (await res.json()) as { counts?: MessageCounts };
		const counts = data.counts;
		if (
			counts &&
			requestGeneration === messageCacheGeneration &&
			countsGeneration === messageCountsGeneration
			&& requestToken === getClientSessionToken()
		) {
			messageCountsCache.set(key, counts);
		}
		return counts;
	})().finally(() => {
		if (messageCountsRequests.get(key)?.promise === request) {
			messageCountsRequests.delete(key);
		}
	});

	messageCountsRequests.set(key, { promise: request, generation: countsGeneration });
	return request;
}

export async function fetchMessageList(params: URLSearchParams, force = false, background = false): Promise<MessageListResponse> {
	ensureMessageClientSession();
	const requestToken = getClientSessionToken();
	const key = params.toString();
	const cached = getCachedMessageList(params);
	if (!force && cached) return cached;
	const pending = messageListRequests.get(key);
	if (pending) {
		if (pending.generation === messageCacheGeneration) return pending.promise;
		const clientGeneration = messageClientGeneration;
		return pending.promise.catch(() => ({})).then((response) =>
			clientGeneration === messageClientGeneration ? fetchMessageList(params, true) : response,
		);
	}

	const requestGeneration = messageCacheGeneration;
	const request = authFetch(`/api/messages?${key}`, {
		cache: force ? "no-store" : "default",
		...(background ? { priority: "low", headers: { "X-Mailflare-Preload": "1" }, redirectOnUnauthorized: false } : {}),
	})
		.then((res) => {
			if (!res.ok) throw new Error(`Message request failed (${res.status})`);
			return res.json();
		})
		.then((data) => {
			const response = data as MessageListResponse;
			if (requestGeneration === messageCacheGeneration && requestToken === getClientSessionToken()) {
				messageListCache.set(key, response);
				if (background) prefetchedMessageListAt.set(key, Date.now());
				else prefetchedMessageListAt.delete(key);
			}
			return response;
		})
		.finally(() => {
			if (messageListRequests.get(key)?.promise === request) {
				messageListRequests.delete(key);
			}
		});

	messageListRequests.set(key, { promise: request, generation: requestGeneration });
	return request;
}

export function getCachedMessageList(params: URLSearchParams): MessageListResponse | undefined {
	ensureMessageClientSession();
	const key = params.toString();
	const prefetchedAt = prefetchedMessageListAt.get(key);
	if (prefetchedAt !== undefined && Date.now() - prefetchedAt >= 120_000) {
		messageListCache.delete(key);
		prefetchedMessageListAt.delete(key);
	}
	return messageListCache.get(key);
}
