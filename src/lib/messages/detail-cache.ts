import { authFetch, getClientSessionToken } from "@/lib/auth/client";
import type { Message } from "@/hooks/types";
import type { CachedMessageDetail } from "./detail-cache-types";

let cacheGeneration = 0;
const detailCache = new Map<string, CachedMessageDetail>();
const detailRequests = new Map<string, Promise<CachedMessageDetail>>();
const detailSizes = new Map<string, number>();
const MAX_DETAIL_ENTRIES = 32;
const MAX_DETAIL_BYTES = 16 * 1024 * 1024;
let detailBytes = 0;

/** Keep moved work bounded on phones too. Estimate UTF-16 strings without
 * serializing an entire body again just to measure its size. */
function cacheDetail(messageId: string, data: CachedMessageDetail) {
	detailBytes -= detailSizes.get(messageId) ?? 0;
	detailCache.delete(messageId); detailSizes.delete(messageId);
	const strings = [...Object.values(data.message ?? {}), ...Object.values(data.body ?? {})];
	const size = 2048 + strings.reduce<number>((total, value) => total + (typeof value === "string" ? value.length * 2 : 0), 0)
		+ (data.attachments ?? []).reduce((total, attachment) => total + 256 + attachment.filename.length * 2, 0);
	// A very large selected mail still displays; it simply isn't retained in the cache.
	if (size > MAX_DETAIL_BYTES) return;
	detailCache.set(messageId, data); detailSizes.set(messageId, size); detailBytes += size;
	while (detailCache.size > MAX_DETAIL_ENTRIES || detailBytes > MAX_DETAIL_BYTES) {
		const oldest = detailCache.keys().next().value!;
		detailBytes -= detailSizes.get(oldest) ?? 0;
		detailSizes.delete(oldest); detailCache.delete(oldest);
	}
}

class MessageResponseError extends Error {
	constructor(readonly status: number) { super("Unable to load message"); }
}

/** Keep brief server outages from turning a selected message into a dead reader. */
async function loadMessageDetail(messageId: string, current: () => boolean): Promise<CachedMessageDetail> {
	const signal = AbortSignal.timeout(30_000);
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await authFetch(`/api/messages/${encodeURIComponent(messageId)}`, { signal, cache: "no-store" });
			if (!response.ok) {
				await response.body?.cancel();
				throw new MessageResponseError(response.status);
			}
			const data = await response.json() as CachedMessageDetail;
			if (!data.message) throw new Error("Unable to load message");
			return data;
		} catch (error) {
			const retryable = error instanceof MessageResponseError
				? [500, 502, 503, 504].includes(error.status)
				: error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
			if (!retryable || attempt >= 2 || signal.aborted || !current()) throw error;
			await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 350 : 1000));
			if (!current()) throw new DOMException("Message request superseded", "AbortError");
		}
	}
}

export function clearMessageDetailCache() {
	cacheGeneration += 1;
	detailCache.clear();
	detailRequests.clear();
	detailSizes.clear(); detailBytes = 0;
}

export function getCachedMessageDetail(messageId: string): CachedMessageDetail | undefined {
	const cached = detailCache.get(messageId);
	if (cached) { detailCache.delete(messageId); detailCache.set(messageId, cached); }
	return cached;
}

export function setCachedMessageRead(messageId: string, read: boolean): void {
	const cached = detailCache.get(messageId);
	if (cached?.message) detailCache.set(messageId, { ...cached, message: { ...cached.message, read } });
}

export function primeMessageDetail(message: Message): void {
	if (message.textBody === undefined && message.htmlBody === undefined) return;
	cacheDetail(message.id, {
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
	if (!force && detailCache.has(messageId)) return getCachedMessageDetail(messageId) ?? {};
	if (detailRequests.has(messageId)) return detailRequests.get(messageId) ?? {};
	const generation = cacheGeneration;
	const token = getClientSessionToken();
	const current = () => generation === cacheGeneration && token === getClientSessionToken();
	const request = loadMessageDetail(messageId, current)
		.then((data) => {
			if (current() && detailRequests.get(messageId) === request) {
				cacheDetail(messageId, data);
			}
			return data;
		})
		.finally(() => {
			if (detailRequests.get(messageId) === request) detailRequests.delete(messageId);
		});
	detailRequests.set(messageId, request);
	return request;
}
