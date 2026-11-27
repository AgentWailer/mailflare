/**
 * Why a message list could not be read, so the notice can say what helps and a blip needs no notice.
 *
 * - `offline`: the browser has no connection, or the server cannot be reached at all.
 * - `sign-in`: something answers in the server's place and asks for a login. An access gateway in
 *   front of the installation (Cloudflare Access) redirects every request once its own session has
 *   run out; only loading the page again signs in there. The application's own expired session
 *   counts too.
 * - `server`: the server answered with an error.
 * - `connection`: the request failed but the server answers again; trying again is all it takes.
 */
export type ListFailure = "offline" | "sign-in" | "server" | "connection";

/** Waits before the automatic tries after a failure; the last one repeats. */
export const LIST_RETRY_DELAYS_MS = [1_500, 5_000, 15_000, 30_000, 60_000];

export function listRetryDelay(attempt: number): number {
	return LIST_RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), LIST_RETRY_DELAYS_MS.length - 1)];
}

/** An error of a list request that the server answered, with the status it answered. */
export function listRequestError(status: number): Error & { status: number } {
	return Object.assign(new Error(`Message request failed (${status})`), { status });
}

/**
 * Asks the server once, without following redirects, to tell a lost connection from a login wall.
 * A same-origin request that is redirected comes back as an opaque redirect; followed, the
 * redirect to another origin would only look like a network failure.
 */
async function probe(): Promise<ListFailure> {
	try {
		const response = await fetch("/api/auth/me", { redirect: "manual", cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(5_000) });
		if (response.type === "opaqueredirect" || response.status === 401) return "sign-in";
		if (response.status >= 500) return "server";
		return "connection";
	} catch {
		return "offline";
	}
}

export async function classifyListFailure(error: unknown): Promise<ListFailure> {
	const status = (error as { status?: unknown } | null)?.status;
	if (typeof status === "number") return status === 401 ? "sign-in" : "server";
	if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
	return probe();
}
