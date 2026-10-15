"use client";

import { AUTH_SESSION_CHANGED_EVENT, authFetch, getClientSessionToken } from "./client";
import type { CurrentUser } from "@/hooks/use-current-user";

export type SessionSnapshot = {
	status: number;
	data: {
		user?: CurrentUser & { timeZone?: string | null };
		hasMailboxes?: boolean;
		isSetup?: boolean;
	} | null;
};
let generation = 0;
let cached: { token: string | null; at: number; value: SessionSnapshot } | null = null;
let pending: { token: string | null; generation: number; promise: Promise<SessionSnapshot> } | null = null;

export function clearSessionSnapshot() {
	generation++;
	cached = null;
	pending = null;
}
if (typeof window !== "undefined") window.addEventListener(AUTH_SESSION_CHANGED_EVENT, clearSessionSnapshot);

/** Share startup identity metadata. API authorization still checks every live request.
 * Guards request fresh validation; their children reuse the just-validated response.
 */
export function fetchSessionSnapshot(force = false): Promise<SessionSnapshot> {
	const token = getClientSessionToken();
	if (pending?.token === token && pending.generation === generation) return pending.promise;
	if (!force && cached?.token === token && Date.now() - cached.at < 5_000) return Promise.resolve(cached.value);
	const requestGeneration = generation;
	const promise = (async () => {
		const authenticated = await authFetch("/api/auth/me", { cache: "no-store", redirectOnUnauthorized: false, signal: AbortSignal.timeout(5_000) });
		// A stale browser token must not hide a valid HttpOnly cookie session.
		const response = authenticated.status === 401 && token
			? await fetch("/api/auth/me", { cache: "no-store", signal: AbortSignal.timeout(5_000) })
			: authenticated;
		const value = { status: response.status, data: response.ok ? await response.json() as SessionSnapshot["data"] : null };
		if (requestGeneration === generation && token === getClientSessionToken()) {
			cached = response.ok ? { token, at: Date.now(), value } : null;
		}
		return value;
	})().finally(() => { if (pending?.promise === promise) pending = null; });
	pending = { token, generation: requestGeneration, promise };
	return promise;
}
