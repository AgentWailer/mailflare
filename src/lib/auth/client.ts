"use client";

import { getUserTimeZone } from "@/lib/time/utils";
import { clearUserTimeZonePreference } from "@/lib/time/client";
import type {
	AuthFetchOptions,
	AuthSessionChangedDetail,
	AuthSessionResponse,
} from "./client-types";

// Browser authentication lives only in the HttpOnly cookie. This random, nonsecret
// marker partitions client caches; it is never accepted as an API credential.
const SESSION_STORAGE_KEY = "mailflare-session-scope";
const LEGACY_TOKEN_STORAGE_KEY = "mailflare-session-token";
export const AUTH_SESSION_CHANGED_EVENT = "mailflare:auth-session-changed";
export const AUTH_SESSION_SCOPE_READY_EVENT = "mailflare:auth-session-scope-ready";
let memoryScope: string | null = null;

function writeSessionScope(scope: string | null): void {
	memoryScope = scope;
	try {
		localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
		if (scope) localStorage.setItem(SESSION_STORAGE_KEY, scope);
		else localStorage.removeItem(SESSION_STORAGE_KEY);
	} catch { /* The cookie remains usable when browser storage is disabled. */ }
}

function dispatchAuthSessionChanged(authenticated: boolean): void {
	try {
		localStorage.removeItem("mailflare-recovery-scope");
		for (const key of Object.keys(sessionStorage)) if (key.startsWith("mailflare-compose-recovery:")) sessionStorage.removeItem(key);
	} catch { /* Storage may be disabled. */ }
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<AuthSessionChangedDetail>(AUTH_SESSION_CHANGED_EVENT, {
			detail: { authenticated },
		}),
	);
}

/** Legacy name retained for cache consumers. Returns a nonsecret scope, never a token. */
export function getClientSessionToken(): string | null {
	if (typeof window === "undefined") return null;
	try {
		// A separate key keeps older tabs from sending the marker as a Bearer token.
		if (localStorage.getItem(LEGACY_TOKEN_STORAGE_KEY)) {
			writeSessionScope(`scope:${crypto.randomUUID()}`);
		} else memoryScope = localStorage.getItem(SESSION_STORAGE_KEY);
	} catch { /* Fall back to this tab's nonsecret scope. */ }
	return memoryScope;
}

/** Login APIs still return tokens for native clients; browsers deliberately discard them. */
export function setClientSessionToken(_token: string): void {
	if (!_token) return;
	writeSessionScope(`scope:${crypto.randomUUID()}`);
	clearUserTimeZonePreference();
	dispatchAuthSessionChanged(true);
}

/** Called only after /auth/me validates a cookie-only returning session. */
export function ensureClientSessionScope(): string {
	const existing = getClientSessionToken();
	if (existing) return existing;
	const scope = `scope:${crypto.randomUUID()}`;
	writeSessionScope(scope);
	// Wake realtime polling without invalidating the session request that created it.
	window.dispatchEvent(new Event(AUTH_SESSION_SCOPE_READY_EVENT));
	return scope;
}

export function clearClientSessionToken(): void {
	writeSessionScope(null);
	clearUserTimeZonePreference();
	dispatchAuthSessionChanged(false);
}

if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.key !== SESSION_STORAGE_KEY && event.key !== null) return;
		const previousScope = memoryScope;
		const nextScope = getClientSessionToken();
		if (event.key === null ? previousScope === nextScope : event.oldValue === event.newValue) return;
		clearUserTimeZonePreference();
		dispatchAuthSessionChanged(!!nextScope);
	});
}

export function getAuthHeaders(headers?: HeadersInit): Headers {
	const nextHeaders = new Headers(headers);
	// Never expose persisted/session Bearer credentials through browser requests.
	nextHeaders.delete("Authorization");
	if (typeof window !== "undefined" && !nextHeaders.has("X-Time-Zone")) {
		nextHeaders.set("X-Time-Zone", getUserTimeZone());
	}
	getClientSessionToken(); // Also scrub credentials left by older app versions.
	return nextHeaders;
}

export async function authFetch(input: RequestInfo | URL, init: AuthFetchOptions = {}): Promise<Response> {
	// Never attach a mailbox session to an external URL supplied by another component.
	if (typeof window !== "undefined") {
		const target = new URL(input instanceof Request ? input.url : String(input), window.location.href);
		if (target.origin !== window.location.origin) throw new TypeError("Authenticated requests must stay on the Mailflare origin");
	}
	const { redirectOnUnauthorized = true, headers, ...requestInit } = init;
	const sessionToken = getClientSessionToken();
	const response = await fetch(input, {
		...requestInit,
		credentials: "same-origin",
		headers: getAuthHeaders(headers ?? (input instanceof Request ? input.headers : undefined)),
	});

	if (response.status === 401 && redirectOnUnauthorized && typeof window !== "undefined"
		&& sessionToken === getClientSessionToken()) {
		clearClientSessionToken();
		// Drop all authenticated in-memory state, including caches outside React.
		// eslint-disable-next-line @next/next/no-location-assign-relative-destination
		window.location.assign("/login");
	}

	return response;
}

export async function persistAuthSession(response: Response): Promise<AuthSessionResponse> {
	const data = (await response.json()) as AuthSessionResponse;
	if (response.ok && data.token) setClientSessionToken(data.token);
	return data;
}
