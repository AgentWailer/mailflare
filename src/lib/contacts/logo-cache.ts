// Derived public artwork only: account-scoped, rediscoverable and excluded from database backups.
const positiveTtl = 30 * 86_400_000;
const negativeTtl = 86_400_000;
const transientTtl = 15 * 60_000;
const maximumBytes = 128 * 1024;
const inFlight = new Map<string, Promise<ArrayBuffer | null>>();

function allowedProvider(url: URL) {
	return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && (url.hostname === "www.google.com" || url.hostname === "gstatic.com" || url.hostname.endsWith(".gstatic.com"));
}

async function discover(domain: string): Promise<{ image: ArrayBuffer | null; ttl: number }> {
	// Only the domain is sent, never the address or any message content. Do not fetch sender-supplied URLs.
	let url = new URL("https://www.google.com/s2/favicons");
	url.searchParams.set("domain", domain);
	url.searchParams.set("sz", "128");
	const signal = AbortSignal.timeout(4000);
	for (let redirects = 0; redirects <= 3; redirects++) {
		const response = await fetch(url, { redirect: "manual", signal, headers: { Accept: "image/png" } });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (!location) return { image: null, ttl: transientTtl };
			url = new URL(location, url);
			if (!allowedProvider(url)) return { image: null, ttl: transientTtl };
			continue;
		}
		if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim() !== "image/png" || Number(response.headers.get("content-length")) > maximumBytes) {
			await response.body?.cancel();
			return { image: null, ttl: response.status === 404 ? negativeTtl : transientTtl };
		}
		const reader = response.body?.getReader();
		if (!reader) return { image: null, ttl: transientTtl };
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > maximumBytes) { await reader.cancel(); return { image: null, ttl: transientTtl }; }
				chunks.push(value);
			}
		} finally { reader.releaseLock(); }
		const data = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
		const signature = [137, 80, 78, 71, 13, 10, 26, 10];
		if (size < 33 || !signature.every((byte, i) => data[i] === byte) || String.fromCharCode(...data.slice(12, 16)) !== "IHDR") return { image: null, ttl: transientTtl };
		const view = new DataView(data.buffer);
		if (![view.getUint32(16), view.getUint32(20)].every(dimension => dimension > 0 && dimension <= 256)) return { image: null, ttl: transientTtl };
		return { image: data.buffer, ttl: positiveTtl };
	}
	return { image: null, ttl: transientTtl };
}

export async function getCachedSenderLogo(bucket: Pick<R2Bucket, "get" | "put">, ownerId: string, domain: string): Promise<ArrayBuffer | null> {
	const key = `sender-logos/${encodeURIComponent(ownerId)}/${domain}`;
	const existing = inFlight.get(key);
	if (existing) return existing;
	const pending = (async () => {
		const image = await bucket.get(`${key}.png`);
		if (image && Number(image.customMetadata?.expiresAt) > Date.now()) return image.arrayBuffer();
		const missing = await bucket.get(`${key}.missing`);
		if (missing && Number(missing.customMetadata?.expiresAt) > Date.now()) return null;
		const result = await discover(domain).catch(() => ({ image: null, ttl: transientTtl }));
		await bucket.put(`${key}${result.image ? ".png" : ".missing"}`, result.image ?? "", { customMetadata: { expiresAt: String(Date.now() + result.ttl) }, ...(result.image ? { httpMetadata: { contentType: "image/png" } } : {}) });
		return result.image;
	})();
	inFlight.set(key, pending);
	try { return await pending; } finally { inFlight.delete(key); }
}
