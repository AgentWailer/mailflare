/**
 * Requests the page starts before the application has loaded.
 *
 * Opening Mailflare used to wait three times in a row, each only after the scripts had run: who is
 * signed in, then which mailboxes, then the list. A small script in the page's head now starts all
 * three while the scripts are still loading, and `authFetch` hands each answer to the first caller
 * that asks for exactly that address. Nothing is cached beyond that one use: a request the
 * application does not ask for within `EARLY_MAX_AGE_MS`, or asks for under another session or time
 * zone, is dropped and made again the ordinary way.
 */

const SESSION_SCOPE_KEY = "mailflare-session-scope";
const LEGACY_TOKEN_KEY = "mailflare-session-token";
const TIME_ZONE_KEY = "mailflare-user-time-zone";
export const START_REQUESTS_KEY = "mailflare-start-requests";
export const EARLY_MAX_AGE_MS = 10_000;
const MAX_START_LISTS = 6;
const LIST_PREFIX = "/api/messages?";

type EarlyState = { scope: string; zone: string; at: number; requests: Record<string, Promise<Response>> };
type EarlyWindow = Window & { __mailflareEarly?: EarlyState };
type StartRequests = { scope: string; lists: [page: string, url: string][] };

/**
 * Runs in the page's head, before any module. Only a browser that was signed in starts anything, so
 * a visitor to the login page sends no mailbox request. The list is the one this page showed first
 * last time (`rememberStartList`); it is taken from storage only as an address below `/api/messages`.
 */
export const earlyRequestsBootstrapScript = `(() => {
	try {
		const scope = localStorage.getItem(${JSON.stringify(SESSION_SCOPE_KEY)});
		if (!scope || localStorage.getItem(${JSON.stringify(LEGACY_TOKEN_KEY)})) return;
		let zone = "";
		try {
			const saved = JSON.parse(localStorage.getItem(${JSON.stringify(TIME_ZONE_KEY)}) || "null");
			if (saved && typeof saved.timeZone === "string") zone = saved.timeZone;
		} catch {}
		if (!zone) zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		const urls = ["/api/auth/me", "/api/mailboxes"];
		try {
			const start = JSON.parse(localStorage.getItem(${JSON.stringify(START_REQUESTS_KEY)}) || "null");
			const page = location.pathname + location.search;
			if (start && start.scope === scope && Array.isArray(start.lists)) {
				const entry = start.lists.find((item) => Array.isArray(item) && item[0] === page);
				if (entry && typeof entry[1] === "string" && entry[1].startsWith(${JSON.stringify(LIST_PREFIX)}) && entry[1].length < 2000) urls.push(entry[1]);
			}
		} catch {}
		const requests = {};
		for (const url of urls) {
			const request = fetch(url, { credentials: "same-origin", cache: url === "/api/auth/me" ? "no-store" : "default", headers: { "X-Time-Zone": zone } });
			request.catch(() => {});
			requests[url] = request;
		}
		window.__mailflareEarly = { scope, zone, at: Date.now(), requests };
	} catch {}
})();`;

/**
 * The answer to `url` if the page already asked for it, once. `scope` and `zone` are what the
 * application would send now; a start under another session or time zone is thrown away whole.
 */
export function takeEarlyResponse(url: string, scope: string | null, zone: string, now = Date.now()): Promise<Response> | null {
	if (typeof window === "undefined") return null;
	const holder = window as EarlyWindow;
	const early = holder.__mailflareEarly;
	if (!early || typeof early !== "object" || !early.requests) return null;
	const age = now - early.at;
	if (!scope || early.scope !== scope || early.zone !== zone || !(age >= 0 && age <= EARLY_MAX_AGE_MS)) {
		delete holder.__mailflareEarly;
		return null;
	}
	if (!Object.hasOwn(early.requests, url)) return null;
	const request = early.requests[url];
	delete early.requests[url];
	return request instanceof Promise ? request : null;
}

/** Waits for an early answer no longer than the caller's own signal allows. */
export function awaitEarlyResponse(request: Promise<Response>, signal?: AbortSignal | null): Promise<Response> {
	if (!signal) return request;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<Response>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

let remembered = false;

/**
 * Notes the list a page shows first, so the next start of that page can ask for it at once. One note
 * per page load: what the reader opens afterwards is not what the next start begins with. Searches and
 * later pages are not noted; a search is not where a start begins, and its words stay out of storage.
 */
export function rememberStartList(listUrl: string, scope: string | null): void {
	if (remembered || typeof window === "undefined" || !scope || !listUrl.startsWith(LIST_PREFIX)) return;
	remembered = true;
	const params = new URLSearchParams(listUrl.slice(LIST_PREFIX.length));
	if (params.has("q") || params.has("title") || params.has("offset")) return;
	try {
		const page = window.location.pathname + window.location.search;
		const stored = JSON.parse(localStorage.getItem(START_REQUESTS_KEY) ?? "null") as StartRequests | null;
		const kept = stored && stored.scope === scope && Array.isArray(stored.lists)
			? stored.lists.filter((entry) => Array.isArray(entry) && entry[0] !== page && typeof entry[1] === "string")
			: [];
		const next: StartRequests = { scope, lists: [[page, listUrl], ...kept].slice(0, MAX_START_LISTS) as StartRequests["lists"] };
		localStorage.setItem(START_REQUESTS_KEY, JSON.stringify(next));
	} catch { /* Storage may be disabled; the next start then asks in the usual order. */ }
}

/** A changed session owns neither the answers already under way nor the noted lists. */
export function forgetStartRequests(): void {
	if (typeof window === "undefined") return;
	delete (window as EarlyWindow).__mailflareEarly;
	try { localStorage.removeItem(START_REQUESTS_KEY); } catch { /* Nothing was stored. */ }
}

/** For tests: a page load notes its first list once. */
export function resetStartListMemory(): void {
	remembered = false;
}
