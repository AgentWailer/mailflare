import { authFetch } from "@/lib/auth/client";
import type { Message } from "@/hooks/types";
import type { CachedMessageDetail } from "./detail-cache-types";

let cacheGeneration = 0;
const detailCache = new Map<string, CachedMessageDetail>();
const detailRequests = new Map<string, Promise<CachedMessageDetail>>();

export function clearMessageDetailCache() {
	cacheGeneration += 1;
	detailCache.clear();
	detailRequests.clear();
}

export function getCachedMessageDetail(messageId: string): CachedMessageDetail | undefined {
	return detailCache.get(messageId);
}

export function setCachedMessageRead(messageId: string, read: boolean): void {
	const cached = detailCache.get(messageId);
	if (cached?.message) detailCache.set(messageId, { ...cached, message: { ...cached.message, read } });
}

export function primeMessageDetail(message: Message): void {
	if (message.textBody === undefined && message.htmlBody === undefined) return;
	detailCache.set(message.id, {
		message,
		body: { textBody: message.textBody ?? null, htmlBody: message.htmlBody ?? null },
	});
}

/** Start the one selected/hovered message while its route code is still loading. */
export function preloadMessageDetail(message: Message): void {
	primeMessageDetail(message);
	void fetchCachedMessageDetail(message.id).catch(() => undefined);
}

export async function fetchCachedMessageDetail(messageId: string, force = false): Promise<CachedMessageDetail> {
	if (!force && detailCache.has(messageId)) return detailCache.get(messageId) ?? {};
	if (detailRequests.has(messageId)) return detailRequests.get(messageId) ?? {};
	const generation = cacheGeneration;
	const request = authFetch(`/api/messages/${messageId}`, { signal: AbortSignal.timeout(30_000) })
		.then(async response => {
			if (!response.ok) throw new Error("Unable to load message");
			const data = await response.json() as CachedMessageDetail;
			if (!data.message) throw new Error("Unable to load message");
			return data;
		})
		.then((data) => {
			if (generation === cacheGeneration && detailRequests.get(messageId) === request) {
				detailCache.set(messageId, data);
			}
			return data;
		})
		.finally(() => {
			if (detailRequests.get(messageId) === request) detailRequests.delete(messageId);
		});
	detailRequests.set(messageId, request);
	return request;
}
