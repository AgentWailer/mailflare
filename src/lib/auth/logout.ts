import { authFetch, clearClientSessionToken, getClientSessionToken, setClientSessionToken } from "@/lib/auth/client";

let pending: Promise<boolean> | null = null;

/** Returns true when another signed-in account on this browser took over. */
export function logoutClientSession(): Promise<boolean> {
	// Repeated clicks must not sign out the next account promoted by the first call.
	if (pending) return pending;
	const scope = getClientSessionToken();
	pending = (async () => {
		const response = await authFetch("/api/auth/logout", {
			method: "POST",
			redirectOnUnauthorized: false,
		});
		const data = await response.json().catch(() => null) as { ok?: boolean; token?: string } | null;
		// Only the server can revoke/clear the HttpOnly cookie. Do not claim logout
		// succeeded on a failed request, or clear a newer account's local state.
		if (!response.ok || data?.ok !== true || scope !== getClientSessionToken()) throw new Error("Could not confirm sign out");
		if (data.token) {
			setClientSessionToken(data.token);
			return true;
		}
		clearClientSessionToken();
		return false;
	})().finally(() => { pending = null; });
	return pending;
}
